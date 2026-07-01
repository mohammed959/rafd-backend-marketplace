import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma';
import { logAction } from '../audit/audit.service';

/**
 * Bulk importer for categories and their subcategories — one row per
 * (category, optional subcategory). A category may span multiple rows to add
 * several subcategories; the category's own fields are taken from its first
 * occurrence.
 *
 * Sheet columns (case/space/underscore-insensitive):
 *   category_name_en, category_name_ar, category_sort, category_status,
 *   subcategory_name_en, subcategory_name_ar, subcategory_sort, sub_category_status
 *
 * Subcategory columns are OPTIONAL. Status TRUE = active, FALSE = inactive
 * (empty defaults to active). Slugs are generated from the English name, so
 * the sheet needs no slug column. Re-importing the same names UPDATES the
 * existing category/subcategory (idempotent).
 */

const HEADER_ALIASES: Record<string, string> = {
  // Category English name
  categorynameen: 'categoryNameEn',
  categoryname: 'categoryNameEn',
  categoryen: 'categoryNameEn',
  // Category Arabic name
  categorynamear: 'categoryNameAr',
  categoryar: 'categoryNameAr',
  // Category sort / status
  categorysort: 'categorySort',
  categoryorder: 'categorySort',
  categorystatus: 'categoryStatus',
  categoryactive: 'categoryStatus',
  // Subcategory English name
  subcategorynameen: 'subNameEn',
  subcategoryname: 'subNameEn',
  subcategoryen: 'subNameEn',
  // Subcategory Arabic name
  subcategorynamear: 'subNameAr',
  subcategoryar: 'subNameAr',
  // Subcategory sort / status ("sub_category_status" also lands here)
  subcategorysort: 'subSort',
  subcategoryorder: 'subSort',
  subcategorystatus: 'subStatus',
  subcategoryactive: 'subStatus',
};

interface ParsedRow {
  rowNumber: number;
  categoryNameEn?: string;
  categoryNameAr?: string;
  categorySort?: number;
  categoryStatus?: boolean;
  subNameEn?: string;
  subNameAr?: string;
  subSort?: number;
  subStatus?: boolean;
}

export interface ImportRowError {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface CategoryImportSummary {
  totalRows: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  subcategoriesCreated: number;
  subcategoriesUpdated: number;
  errors: ImportRowError[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeHeader(raw: string): string | undefined {
  const key = raw.trim().toLowerCase().replace(/[_\s]+/g, '');
  return HEADER_ALIASES[key];
}

/** TRUE/FALSE/1/0/yes/no → boolean. `undefined` when the cell is empty so
 *  callers can apply their own default (active). */
function coerceBool(v: unknown): boolean | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(s)) return false;
  return undefined;
}

function coerceNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = (typeof v === 'string' ? v : String(v)).trim();
  return s.length === 0 ? undefined : s;
}

async function parseSheet(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no sheets');

  const headerMap = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, col) => {
    const mapped = normalizeHeader(String(cell.value ?? ''));
    if (mapped) headerMap.set(col, mapped);
  });
  if (headerMap.size === 0) {
    throw new Error('First row must contain headers (e.g. category_name_en, category_name_ar).');
  }

  const rows: ParsedRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: ParsedRow = { rowNumber };
    let anyValue = false;
    row.eachCell((cell, col) => {
      const key = headerMap.get(col);
      if (!key) return;
      const raw: unknown =
        cell.value && typeof cell.value === 'object' && 'result' in (cell.value as object)
          ? (cell.value as { result: unknown }).result
          : cell.value;
      if (raw == null || raw === '') return;
      anyValue = true;
      switch (key) {
        case 'categorySort':
        case 'subSort':
          (obj as unknown as Record<string, unknown>)[key] = coerceNum(raw);
          break;
        case 'categoryStatus':
        case 'subStatus':
          (obj as unknown as Record<string, unknown>)[key] = coerceBool(raw);
          break;
        default:
          (obj as unknown as Record<string, unknown>)[key] = coerceStr(raw);
      }
    });
    if (anyValue) rows.push(obj);
  });

  return rows;
}

export async function importCategoriesFromExcel(
  buffer: Buffer,
  actorId: string,
): Promise<CategoryImportSummary> {
  const rows = await parseSheet(buffer);
  const errors: ImportRowError[] = [];

  // First occurrence of each category defines its fields; later rows for the
  // same category only contribute subcategories.
  const catOrder: string[] = [];
  const catDef = new Map<string, { nameEn: string; nameAr: string; sort: number; status: boolean }>();
  interface SubRow {
    rowNumber: number;
    catSlug: string;
    nameEn: string;
    nameAr: string;
    sort: number;
    status: boolean;
  }
  const subRows: SubRow[] = [];

  for (const row of rows) {
    const nameEn = row.categoryNameEn;
    const nameAr = row.categoryNameAr;
    if (!nameEn) {
      errors.push({ rowNumber: row.rowNumber, field: 'category_name_en', message: 'Category English name is required.' });
      continue;
    }
    if (!nameAr) {
      errors.push({ rowNumber: row.rowNumber, field: 'category_name_ar', message: 'Category Arabic name is required.' });
      continue;
    }
    const catSlug = slugify(nameEn);
    if (!catSlug) {
      errors.push({ rowNumber: row.rowNumber, field: 'category_name_en', message: 'Category English name must contain letters or numbers.' });
      continue;
    }
    if (!catDef.has(catSlug)) {
      catOrder.push(catSlug);
      catDef.set(catSlug, {
        nameEn,
        nameAr,
        sort: row.categorySort ?? 0,
        status: row.categoryStatus ?? true,
      });
    }

    // Optional subcategory — both names required together when present.
    const subEn = row.subNameEn;
    const subAr = row.subNameAr;
    if (subEn || subAr) {
      if (!subEn) {
        errors.push({ rowNumber: row.rowNumber, field: 'subcategory_name_en', message: 'Subcategory English name is required when adding a subcategory.' });
        continue;
      }
      if (!subAr) {
        errors.push({ rowNumber: row.rowNumber, field: 'subcategory_name_ar', message: 'Subcategory Arabic name is required when adding a subcategory.' });
        continue;
      }
      if (!slugify(subEn)) {
        errors.push({ rowNumber: row.rowNumber, field: 'subcategory_name_en', message: 'Subcategory English name must contain letters or numbers.' });
        continue;
      }
      subRows.push({
        rowNumber: row.rowNumber,
        catSlug,
        nameEn: subEn,
        nameAr: subAr,
        sort: row.subSort ?? 0,
        status: row.subStatus ?? true,
      });
    }
  }

  // Upsert categories.
  const existingCats = await prisma.category.findMany({ where: { slug: { in: catOrder } } });
  const catBySlug = new Map(existingCats.map((c) => [c.slug, c]));
  let categoriesCreated = 0;
  let categoriesUpdated = 0;

  for (const slug of catOrder) {
    const def = catDef.get(slug)!;
    try {
      if (catBySlug.has(slug)) {
        const updated = await prisma.category.update({
          where: { slug },
          data: { name: def.nameEn, nameAr: def.nameAr, sortOrder: def.sort, isActive: def.status },
        });
        catBySlug.set(slug, updated);
        categoriesUpdated += 1;
      } else {
        const cCreated = await prisma.category.create({
          data: { name: def.nameEn, nameAr: def.nameAr, slug, sortOrder: def.sort, isActive: def.status },
        });
        catBySlug.set(slug, cCreated);
        categoriesCreated += 1;
      }
    } catch (err) {
      errors.push({ rowNumber: 0, field: 'category', message: `Category "${def.nameEn}": ${(err as Error).message}` });
    }
  }

  // Upsert subcategories (slug scoped to the category to stay globally unique).
  const subSlugs = subRows.map((s) => `${s.catSlug}-${slugify(s.nameEn)}`);
  const existingSubs = await prisma.subcategory.findMany({ where: { slug: { in: subSlugs } } });
  const subBySlug = new Map(existingSubs.map((s) => [s.slug, s]));
  const seenSub = new Set<string>();
  let subcategoriesCreated = 0;
  let subcategoriesUpdated = 0;

  for (const s of subRows) {
    const cat = catBySlug.get(s.catSlug);
    if (!cat) continue; // parent category failed — error already reported
    const subSlug = `${s.catSlug}-${slugify(s.nameEn)}`;
    if (seenSub.has(subSlug)) continue; // duplicate within the file — keep first
    seenSub.add(subSlug);
    try {
      if (subBySlug.has(subSlug)) {
        await prisma.subcategory.update({
          where: { slug: subSlug },
          data: { categoryId: cat.id, name: s.nameEn, nameAr: s.nameAr, sortOrder: s.sort, isActive: s.status },
        });
        subcategoriesUpdated += 1;
      } else {
        await prisma.subcategory.create({
          data: { categoryId: cat.id, name: s.nameEn, nameAr: s.nameAr, slug: subSlug, sortOrder: s.sort, isActive: s.status },
        });
        subcategoriesCreated += 1;
      }
    } catch (err) {
      errors.push({ rowNumber: s.rowNumber, field: 'subcategory', message: `Subcategory "${s.nameEn}": ${(err as Error).message}` });
    }
  }

  await logAction({
    actorId,
    actorRole: 'SUPER_ADMIN',
    action: 'category.import',
    entityType: 'category_import',
    changes: {
      totalRows: rows.length,
      categoriesCreated,
      categoriesUpdated,
      subcategoriesCreated,
      subcategoriesUpdated,
      errorCount: errors.length,
    },
  });

  return {
    totalRows: rows.length,
    categoriesCreated,
    categoriesUpdated,
    subcategoriesCreated,
    subcategoriesUpdated,
    errors,
  };
}

export async function buildCategoryTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Categories');
  sheet.columns = [
    { header: 'category_name_en', key: 'categoryNameEn', width: 24 },
    { header: 'category_name_ar', key: 'categoryNameAr', width: 24 },
    { header: 'category_sort', key: 'categorySort', width: 14 },
    { header: 'category_status', key: 'categoryStatus', width: 16 },
    { header: 'subcategory_name_en', key: 'subNameEn', width: 24 },
    { header: 'subcategory_name_ar', key: 'subNameAr', width: 24 },
    { header: 'subcategory_sort', key: 'subSort', width: 16 },
    { header: 'sub_category_status', key: 'subStatus', width: 18 },
  ];

  // Category with two subcategories (repeat the category on each row).
  sheet.addRow({ categoryNameEn: 'Dairy', categoryNameAr: 'الألبان', categorySort: 1, categoryStatus: 'TRUE', subNameEn: 'Milk', subNameAr: 'حليب', subSort: 1, subStatus: 'TRUE' });
  sheet.addRow({ categoryNameEn: 'Dairy', categoryNameAr: 'الألبان', categorySort: 1, categoryStatus: 'TRUE', subNameEn: 'Cheese', subNameAr: 'جبن', subSort: 2, subStatus: 'TRUE' });
  // Category with no subcategory (subcategory columns left blank).
  sheet.addRow({ categoryNameEn: 'Bakery', categoryNameAr: 'المخبوزات', categorySort: 2, categoryStatus: 'TRUE' });
  // Inactive category example.
  sheet.addRow({ categoryNameEn: 'Seasonal', categoryNameAr: 'موسمي', categorySort: 3, categoryStatus: 'FALSE' });

  const arr = await workbook.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}
