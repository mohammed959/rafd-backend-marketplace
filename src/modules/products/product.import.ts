import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma';
import { logAction } from '../audit/audit.service';

/**
 * Flat product importer — one row per product. No variant fields are
 * accepted; price, quantity, SKU and barcode are product-level columns.
 *
 * Spec columns (case-insensitive, whitespace/underscore tolerant):
 *   Required: name, nameAr, brand (slug), category (slug), sku, price, quantity
 *   Optional: description, descriptionAr, subcategory (slug), barcode, featured
 *
 * Header aliases below let operators paste from a variety of
 * spreadsheets while still mapping to a single canonical field.
 */
// IMPORTANT: every key here MUST be already normalized (lowercase, no
// spaces or underscores). `normalizeHeader` strips those before the
// lookup, so a key like 'arabic name' would be unreachable.
const HEADER_ALIASES: Record<string, string> = {
  // English name
  name: 'name',
  productname: 'name',
  englishname: 'name',
  // Arabic name
  namear: 'nameAr',
  arabicname: 'nameAr',
  productnamear: 'nameAr',
  // Descriptions
  description: 'description',
  englishdescription: 'description',
  descriptionar: 'descriptionAr',
  arabicdescription: 'descriptionAr',
  // Category / subcategory
  categoryslug: 'categorySlug',
  category: 'categorySlug',
  subcategoryslug: 'subcategorySlug',
  subcategory: 'subcategorySlug',
  // Brand
  brandslug: 'brandSlug',
  brand: 'brandSlug',
  // Inventory & pricing
  sku: 'sku',
  barcode: 'barcode',
  price: 'price',
  quantity: 'quantity',
  stock: 'quantity',
  // Admin flags
  featured: 'featured',
};

interface ParsedRow {
  rowNumber: number;
  name?: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  categorySlug?: string;
  subcategorySlug?: string;
  brandSlug?: string;
  featured?: boolean;
  sku?: string;
  barcode?: string;
  price?: number;
  quantity?: number;
}

export interface ImportRowError {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface ImportSummary {
  totalRows: number;
  productsCreated: number;
  errors: ImportRowError[];
}

function normalizeHeader(raw: string): string | undefined {
  const key = raw.trim().toLowerCase().replace(/[_\s]+/g, '');
  return HEADER_ALIASES[key];
}

function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  }
  return false;
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
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length === 0 ? undefined : s;
  }
  return String(v).trim() || undefined;
}

async function parseSheet(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no sheets');

  const headerMap = new Map<number, string>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, col) => {
    const mapped = normalizeHeader(String(cell.value ?? ''));
    if (mapped) headerMap.set(col, mapped);
  });
  if (headerMap.size === 0) throw new Error('First row must contain headers');

  const rows: ParsedRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: ParsedRow = { rowNumber };
    let anyValue = false;
    row.eachCell((cell, col) => {
      const key = headerMap.get(col);
      if (!key) return;
      const raw: unknown = (cell.value && typeof cell.value === 'object' && 'result' in (cell.value as any))
        ? (cell.value as any).result
        : cell.value;
      if (raw == null || raw === '') return;
      anyValue = true;

      switch (key) {
        case 'price':
        case 'quantity':
          (obj as unknown as Record<string, unknown>)[key] = coerceNum(raw);
          break;
        case 'featured':
          obj.featured = coerceBool(raw);
          break;
        default:
          (obj as unknown as Record<string, unknown>)[key] = coerceStr(raw);
      }
    });
    if (anyValue) rows.push(obj);
  });

  return rows;
}

export async function importProductsFromExcel(buffer: Buffer, actorId: string): Promise<ImportSummary> {
  const rows = await parseSheet(buffer);
  const errors: ImportRowError[] = [];

  // Resolve all referenced slugs in bulk.
  const categorySlugs = new Set<string>();
  const subcategorySlugs = new Set<string>();
  const brandSlugs = new Set<string>();
  for (const row of rows) {
    if (row.categorySlug) categorySlugs.add(row.categorySlug.toLowerCase());
    if (row.subcategorySlug) subcategorySlugs.add(row.subcategorySlug.toLowerCase());
    if (row.brandSlug) brandSlugs.add(row.brandSlug.toLowerCase());
  }
  const [foundCategories, foundSubcategories, foundBrands] = await Promise.all([
    prisma.category.findMany({ where: { slug: { in: Array.from(categorySlugs) } } }),
    prisma.subcategory.findMany({ where: { slug: { in: Array.from(subcategorySlugs) } } }),
    prisma.brand.findMany({ where: { slug: { in: Array.from(brandSlugs) } } }),
  ]);
  const catBySlug = new Map(foundCategories.map((c) => [c.slug.toLowerCase(), c]));
  const subBySlug = new Map(foundSubcategories.map((s) => [s.slug.toLowerCase(), s]));
  const brandBySlug = new Map(foundBrands.map((b) => [b.slug.toLowerCase(), b]));

  // SKU conflict check across the file + DB.
  const fileSkus = rows.map((r) => r.sku?.trim()).filter((s): s is string => Boolean(s));
  const existingSkuRows = await prisma.product.findMany({
    where: { sku: { in: fileSkus } },
    select: { sku: true },
  });
  const existingSkus = new Set(existingSkuRows.map((r) => r.sku).filter(Boolean) as string[]);

  // Detect SKUs that appear more than once within the uploaded file so
  // operators see a clear "duplicated in the file" error instead of a
  // generic DB-error reported on the second row.
  const skuCountInFile = new Map<string, number>();
  for (const sku of fileSkus) {
    skuCountInFile.set(sku, (skuCountInFile.get(sku) ?? 0) + 1);
  }

  let productsCreated = 0;

  for (const row of rows) {
    // Names — both required
    if (!row.name) {
      errors.push({ rowNumber: row.rowNumber, field: 'name', message: 'English name is required' });
      continue;
    }
    if (!row.nameAr) {
      errors.push({ rowNumber: row.rowNumber, field: 'nameAr', message: 'Arabic name is required' });
      continue;
    }

    // Category — required, must exist
    if (!row.categorySlug) {
      errors.push({ rowNumber: row.rowNumber, field: 'category', message: 'Category is required' });
      continue;
    }
    const cat = catBySlug.get(row.categorySlug.toLowerCase());
    if (!cat) {
      errors.push({ rowNumber: row.rowNumber, field: 'category', message: `Category "${row.categorySlug}" not found — create it before importing.` });
      continue;
    }

    // Brand — required, must exist AND be active
    if (!row.brandSlug) {
      errors.push({ rowNumber: row.rowNumber, field: 'brand', message: 'Brand is required — every product must belong to a brand.' });
      continue;
    }
    const brand = brandBySlug.get(row.brandSlug.toLowerCase());
    if (!brand) {
      errors.push({ rowNumber: row.rowNumber, field: 'brand', message: `Brand "${row.brandSlug}" not found — create it before importing.` });
      continue;
    }
    if (!brand.isActive) {
      errors.push({ rowNumber: row.rowNumber, field: 'brand', message: `Brand "${row.brandSlug}" is inactive — re-activate it before importing.` });
      continue;
    }

    // Subcategory — optional. If provided, must exist AND belong to the
    // chosen category so we never store a mismatched (cat, subcat) pair.
    let subId: string | null = null;
    if (row.subcategorySlug) {
      const sub = subBySlug.get(row.subcategorySlug.toLowerCase());
      if (!sub) {
        errors.push({ rowNumber: row.rowNumber, field: 'subcategory', message: `Subcategory "${row.subcategorySlug}" not found.` });
        continue;
      }
      if (sub.categoryId !== cat.id) {
        errors.push({
          rowNumber: row.rowNumber,
          field: 'subcategory',
          message: `Subcategory "${row.subcategorySlug}" does not belong to category "${row.categorySlug}".`,
        });
        continue;
      }
      subId = sub.id;
    }

    // SKU — required, unique in the file AND in the database
    if (!row.sku) {
      errors.push({ rowNumber: row.rowNumber, field: 'sku', message: 'SKU is required' });
      continue;
    }
    const sku = row.sku.trim();
    if ((skuCountInFile.get(sku) ?? 0) > 1) {
      errors.push({
        rowNumber: row.rowNumber,
        field: 'sku',
        message: `SKU "${sku}" appears more than once in this file.`,
      });
      continue;
    }
    if (existingSkus.has(sku)) {
      errors.push({ rowNumber: row.rowNumber, field: 'sku', message: `SKU "${sku}" already exists in the catalog.` });
      continue;
    }

    // Price — required, > 0
    if (row.price == null || row.price <= 0) {
      errors.push({ rowNumber: row.rowNumber, field: 'price', message: 'Price must be greater than 0' });
      continue;
    }

    // Quantity — required, integer >= 0
    if (row.quantity == null || row.quantity < 0) {
      errors.push({ rowNumber: row.rowNumber, field: 'quantity', message: 'Quantity must be 0 or greater' });
      continue;
    }

    try {
      // Flat product: no variants array is passed. The product is
      // created with product-level price/stock/sku/barcode and a brand
      // FK. Description/subcategory remain undefined when not supplied,
      // so the optional columns stay truly optional.
      await prisma.product.create({
        data: {
          name: row.name.trim(),
          nameAr: row.nameAr.trim(),
          description: row.description?.trim(),
          descriptionAr: row.descriptionAr?.trim(),
          isFeatured: Boolean(row.featured),
          categoryId: cat.id,
          subcategoryId: subId,
          brandId: brand.id,
          sku,
          barcode: row.barcode?.trim(),
          price: row.price,
          stock: Math.floor(row.quantity),
        },
      });
      existingSkus.add(sku);
      productsCreated += 1;
    } catch (err) {
      errors.push({ rowNumber: row.rowNumber, message: `Database error: ${(err as Error).message}` });
    }
  }

  await logAction({
    actorId, actorRole: 'SUPER_ADMIN',
    action: 'product.import',
    entityType: 'product_import',
    changes: { totalRows: rows.length, productsCreated, errorCount: errors.length },
  });

  return { totalRows: rows.length, productsCreated, errors };
}

export async function buildSampleTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.columns = [
    // Required core
    { header: 'name',            key: 'name',            width: 28 },
    { header: 'nameAr',          key: 'nameAr',          width: 28 },
    // Required classification
    { header: 'brandSlug',       key: 'brandSlug',       width: 18 },
    { header: 'categorySlug',    key: 'categorySlug',    width: 18 },
    // Optional classification
    { header: 'subcategorySlug', key: 'subcategorySlug', width: 18 },
    // Optional descriptions
    { header: 'description',     key: 'description',     width: 30 },
    { header: 'descriptionAr',   key: 'descriptionAr',   width: 30 },
    // Required inventory & pricing
    { header: 'sku',             key: 'sku',             width: 18 },
    { header: 'price',           key: 'price',           width: 10 },
    { header: 'quantity',        key: 'quantity',        width: 10 },
    // Optional inventory & flags
    { header: 'barcode',         key: 'barcode',         width: 18 },
    { header: 'featured',        key: 'featured',        width: 10 },
  ];

  // Row 1 — every field populated.
  sheet.addRow({
    name: 'Almarai Milk 1L',
    nameAr: 'حليب المراعي 1 لتر',
    brandSlug: 'almarai',
    categorySlug: 'dairy',
    subcategorySlug: 'milk',
    description: 'Long life full-fat milk',
    descriptionAr: 'حليب طويل العمر كامل الدسم',
    sku: 'MLK-1L',
    price: 6.5,
    quantity: 100,
    barcode: '6281234567890',
    featured: true,
  });

  // Row 2 — optional fields left blank to show the minimum viable shape.
  sheet.addRow({
    name: 'Basic Soap Bar',
    nameAr: 'صابون أساسي',
    brandSlug: 'generic',
    categorySlug: 'household',
    sku: 'SOAP-BAR',
    price: 3,
    quantity: 50,
  });

  const arr = await workbook.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}
