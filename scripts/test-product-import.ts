/**
 * Standalone test runner for the flat product importer.
 *
 * Why a custom runner instead of jest/vitest:
 *   • The importer's dependencies (Prisma client, audit logger) are heavy
 *     and require a live DB. This script intercepts `lib/prisma` and
 *     `audit/audit.service` via `require.cache` BEFORE the importer is
 *     loaded, so it can run with no MySQL connection.
 *   • Run with: `npx ts-node scripts/test-product-import.ts` from
 *     backend/. Exit code is non-zero on any failed assertion.
 *
 * Covers:
 *   - Template download structure
 *   - Header parsing + alias tolerance
 *   - Every required-field / optional-field validation branch
 *   - Brand match (exists, inactive, missing) + Category / Subcategory
 *     match (exists, mismatched parent, missing)
 *   - SKU dedup (within-file + DB)
 *   - Price / quantity bounds
 *   - Successful create payload shape — must be flat, no variants
 */
import ExcelJS from 'exceljs';

// ─── Mock state shared with the mock Prisma client ─────────────────
let mockBrands: Array<{ id: string; slug: string; isActive: boolean }> = [];
let mockCategories: Array<{ id: string; slug: string }> = [];
let mockSubcategories: Array<{ id: string; slug: string; categoryId: string }> = [];
let mockExistingSkus: Set<string> = new Set();
let createCalls: Array<Record<string, any>> = [];

function resetMockState() {
  mockBrands = [];
  mockCategories = [];
  mockSubcategories = [];
  mockExistingSkus = new Set();
  createCalls = [];
}

const mockPrisma = {
  category: {
    findMany: async ({ where }: any) => {
      const slugs: string[] = where?.slug?.in ?? [];
      return mockCategories.filter((c) => slugs.includes(c.slug.toLowerCase()));
    },
  },
  subcategory: {
    findMany: async ({ where }: any) => {
      const slugs: string[] = where?.slug?.in ?? [];
      return mockSubcategories.filter((s) => slugs.includes(s.slug.toLowerCase()));
    },
  },
  brand: {
    findMany: async ({ where }: any) => {
      const slugs: string[] = where?.slug?.in ?? [];
      return mockBrands.filter((b) => slugs.includes(b.slug.toLowerCase()));
    },
  },
  product: {
    findMany: async ({ where }: any) => {
      const skus: string[] = where?.sku?.in ?? [];
      return Array.from(mockExistingSkus)
        .filter((s) => skus.includes(s))
        .map((sku) => ({ sku }));
    },
    create: async ({ data }: { data: any }) => {
      if (mockExistingSkus.has(data.sku)) {
        const err: any = new Error('Unique constraint failed on the fields: (`sku`)');
        err.code = 'P2002';
        throw err;
      }
      mockExistingSkus.add(data.sku);
      createCalls.push(data);
      return { id: 'mock-id-' + data.sku, ...data };
    },
  },
};

// ─── require.cache interception ────────────────────────────────────
// Replace lib/prisma and audit/audit.service modules in the require
// cache so the importer's relative imports resolve to our mocks.
const prismaPath = require.resolve('../src/lib/prisma');
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { prisma: mockPrisma },
} as any;

const auditPath = require.resolve('../src/modules/audit/audit.service');
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { logAction: async () => {} },
} as any;

// Now load the importer (which will see the mocked modules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const importer = require('../src/modules/products/product.import');
const { importProductsFromExcel, buildSampleTemplate } = importer as typeof import('../src/modules/products/product.import');

// ─── Test harness ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function group(name: string, body: () => Promise<void>) {
  console.log(`\n▸ ${name}`);
  await body();
}

const CANONICAL_HEADERS = [
  'name', 'nameAr', 'brandSlug', 'categorySlug', 'subcategorySlug',
  'description', 'descriptionAr', 'sku', 'price', 'quantity', 'barcode', 'featured',
];

async function buildUpload(rows: Array<Record<string, unknown>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test');
  ws.addRow(CANONICAL_HEADERS);
  for (const row of rows) {
    ws.addRow(CANONICAL_HEADERS.map((h) => (row[h] === undefined ? null : (row[h] as any))));
  }
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}

// ─── Tests ─────────────────────────────────────────────────────────
async function main() {
  await group('1. Template download', async () => {
    const buf = await buildSampleTemplate();
    expect('buildSampleTemplate returns a non-empty Buffer', Buffer.isBuffer(buf) && buf.length > 0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const sheet = wb.worksheets[0];
    expect('template has at least one sheet', !!sheet);

    const headerCells: string[] = [];
    sheet.getRow(1).eachCell((cell) => headerCells.push(String(cell.value ?? '')));

    const expected = [
      'name', 'nameAr',
      'brandSlug', 'categorySlug', 'subcategorySlug',
      'description', 'descriptionAr',
      'sku', 'price', 'quantity', 'barcode', 'featured',
    ];
    expect(
      `template headers match spec (${expected.join(', ')})`,
      expected.every((h) => headerCells.includes(h)),
      `got: ${headerCells.join(', ')}`,
    );

    // The variant headers must NOT appear in the new template.
    const forbidden = ['variantType', 'variantSku', 'variantBarcode', 'variantPrice', 'variantQuantity', 'piece', 'carton', 'dozen', 'bundle'];
    expect(
      'template has NO variant columns',
      !forbidden.some((h) => headerCells.includes(h)),
    );

    // At least two example rows so operators see the minimum viable shape.
    expect('template has 2 example rows', sheet.actualRowCount >= 3);
  });

  await group('2. Required field validation — entirely blank row is silently skipped', async () => {
    resetMockState();
    const buf = await buildUpload([{}]);
    const res = await importProductsFromExcel(buf, 'tester');
    // parseSheet drops rows where every cell is blank, so the importer
    // doesn't surface a confusing "X is required" toast for empty
    // trailing rows in the worksheet.
    expect('no products created', res.productsCreated === 0);
    expect('no errors reported', res.errors.length === 0);
  });

  await group('2b. Required field validation — partially-filled row reports the first missing required field', async () => {
    resetMockState();
    const buf = await buildUpload([{ description: 'lone description' }]);
    const res = await importProductsFromExcel(buf, 'tester');
    expect('English name required surfaces', res.errors.some((e) => /English name is required/.test(e.message)));
  });

  await group('3. Required field validation — missing nameAr', async () => {
    resetMockState();
    const buf = await buildUpload([{ name: 'Only English' }]);
    const res = await importProductsFromExcel(buf, 'tester');
    expect('reports Arabic name required', res.errors.some((e) => e.message.includes('Arabic name is required')));
  });

  await group('4. Brand required + matching', async () => {
    // No brand provided
    resetMockState();
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    let res = await importProductsFromExcel(
      await buildUpload([{ name: 'X', nameAr: 'س', categorySlug: 'dairy', sku: 'A', price: 1, quantity: 1 }]),
      'tester',
    );
    expect('blank brand → Brand is required', res.errors.some((e) => /Brand is required/.test(e.message)));

    // Brand provided but not in DB
    resetMockState();
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    res = await importProductsFromExcel(
      await buildUpload([{ name: 'X', nameAr: 'س', brandSlug: 'ghost', categorySlug: 'dairy', sku: 'A', price: 1, quantity: 1 }]),
      'tester',
    );
    expect('unknown brand → "Brand … not found"', res.errors.some((e) => /Brand "ghost" not found/.test(e.message)));

    // Brand inactive
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'inactivebrand', isActive: false }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    res = await importProductsFromExcel(
      await buildUpload([{ name: 'X', nameAr: 'س', brandSlug: 'inactivebrand', categorySlug: 'dairy', sku: 'A', price: 1, quantity: 1 }]),
      'tester',
    );
    expect('inactive brand → "is inactive"', res.errors.some((e) => /is inactive/.test(e.message)));
  });

  await group('5. Category required + matching', async () => {
    // No category provided
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    let res = await importProductsFromExcel(
      await buildUpload([{ name: 'X', nameAr: 'س', brandSlug: 'almarai', sku: 'A', price: 1, quantity: 1 }]),
      'tester',
    );
    expect('blank category → Category is required', res.errors.some((e) => /Category is required/.test(e.message)));

    // Category not in DB
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    res = await importProductsFromExcel(
      await buildUpload([{ name: 'X', nameAr: 'س', brandSlug: 'almarai', categorySlug: 'ghost', sku: 'A', price: 1, quantity: 1 }]),
      'tester',
    );
    expect('unknown category → "Category … not found"', res.errors.some((e) => /Category "ghost" not found/.test(e.message)));
  });

  await group('6. Subcategory is optional but validated when present', async () => {
    // Subcategory blank → product still imports.
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    let res = await importProductsFromExcel(
      await buildUpload([{
        name: 'Milk', nameAr: 'حليب',
        brandSlug: 'almarai', categorySlug: 'dairy',
        sku: 'M1', price: 5, quantity: 10,
      }]),
      'tester',
    );
    expect('blank subcategory → 1 product created', res.productsCreated === 1 && res.errors.length === 0);

    // Subcategory provided but doesn't exist
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    res = await importProductsFromExcel(
      await buildUpload([{
        name: 'Milk', nameAr: 'حليب',
        brandSlug: 'almarai', categorySlug: 'dairy', subcategorySlug: 'ghost',
        sku: 'M2', price: 5, quantity: 10,
      }]),
      'tester',
    );
    expect('unknown subcategory → "not found"', res.errors.some((e) => /Subcategory "ghost" not found/.test(e.message)));

    // Subcategory belongs to a DIFFERENT category
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }, { id: 'cat2', slug: 'household' }];
    mockSubcategories = [{ id: 'sub1', slug: 'detergent', categoryId: 'cat2' }];
    res = await importProductsFromExcel(
      await buildUpload([{
        name: 'Milk', nameAr: 'حليب',
        brandSlug: 'almarai', categorySlug: 'dairy', subcategorySlug: 'detergent',
        sku: 'M3', price: 5, quantity: 10,
      }]),
      'tester',
    );
    expect(
      'mismatched subcategory → "does not belong to category"',
      res.errors.some((e) => /does not belong to category/.test(e.message)),
    );
  });

  await group('7. SKU dedup — within file + against DB', async () => {
    // Within-file duplicate
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    let res = await importProductsFromExcel(
      await buildUpload([
        { name: 'A', nameAr: 'أ', brandSlug: 'almarai', categorySlug: 'dairy', sku: 'DUP', price: 1, quantity: 1 },
        { name: 'B', nameAr: 'ب', brandSlug: 'almarai', categorySlug: 'dairy', sku: 'DUP', price: 1, quantity: 1 },
      ]),
      'tester',
    );
    expect(
      'duplicate SKU in file → "appears more than once"',
      res.errors.filter((e) => /appears more than once in this file/.test(e.message)).length === 2,
    );
    expect('zero products created on file-internal dup', res.productsCreated === 0);

    // SKU already in DB
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    mockExistingSkus = new Set(['TAKEN']);
    res = await importProductsFromExcel(
      await buildUpload([{
        name: 'A', nameAr: 'أ', brandSlug: 'almarai', categorySlug: 'dairy',
        sku: 'TAKEN', price: 1, quantity: 1,
      }]),
      'tester',
    );
    expect('existing DB SKU → "already exists in the catalog"', res.errors.some((e) => /already exists in the catalog/.test(e.message)));
  });

  await group('8. Price + quantity bounds', async () => {
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    let res = await importProductsFromExcel(
      await buildUpload([{
        name: 'A', nameAr: 'أ', brandSlug: 'almarai', categorySlug: 'dairy',
        sku: 'P1', price: 0, quantity: 1,
      }]),
      'tester',
    );
    expect('price=0 → "must be greater than 0"', res.errors.some((e) => /Price must be greater than 0/.test(e.message)));

    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];
    res = await importProductsFromExcel(
      await buildUpload([{
        name: 'A', nameAr: 'أ', brandSlug: 'almarai', categorySlug: 'dairy',
        sku: 'P2', price: 5, quantity: -1,
      }]),
      'tester',
    );
    expect('quantity=-1 → "Quantity must be 0 or greater"', res.errors.some((e) => /Quantity must be 0 or greater/.test(e.message)));
  });

  await group('9. Happy path — full row, all fields, no variants in the create payload', async () => {
    resetMockState();
    mockBrands = [{ id: 'b_almarai', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'c_dairy', slug: 'dairy' }];
    mockSubcategories = [{ id: 's_milk', slug: 'milk', categoryId: 'c_dairy' }];
    const res = await importProductsFromExcel(
      await buildUpload([{
        name: 'Almarai Milk 1L', nameAr: 'حليب المراعي 1 لتر',
        brandSlug: 'almarai', categorySlug: 'dairy', subcategorySlug: 'milk',
        description: 'Long life full-fat milk', descriptionAr: 'حليب طويل العمر كامل الدسم',
        sku: 'MLK-1L', price: 6.5, quantity: 100,
        barcode: '6281234567890', featured: true,
      }]),
      'tester',
    );
    expect('1 product created, 0 errors', res.productsCreated === 1 && res.errors.length === 0);
    expect('exactly one create() call recorded', createCalls.length === 1);

    const created = createCalls[0];
    expect('create payload has name + nameAr',
      created?.name === 'Almarai Milk 1L' && created?.nameAr === 'حليب المراعي 1 لتر');
    expect('create payload has brandId + categoryId + subcategoryId',
      created?.brandId === 'b_almarai' && created?.categoryId === 'c_dairy' && created?.subcategoryId === 's_milk');
    expect('create payload has sku + barcode + price + stock',
      created?.sku === 'MLK-1L' && created?.barcode === '6281234567890' &&
      created?.price === 6.5 && created?.stock === 100);
    expect('description + descriptionAr written through',
      created?.description === 'Long life full-fat milk' &&
      created?.descriptionAr === 'حليب طويل العمر كامل الدسم');
    expect('isFeatured=true preserved', created?.isFeatured === true);

    // The defining invariant of the flat product model: no variants in the payload.
    expect('NO variants field in create payload', !('variants' in (created ?? {})));
    expect('NO variantType field in create payload', !('variantType' in (created ?? {})));
  });

  await group('10. Happy path — minimum viable row (optional fields blank)', async () => {
    resetMockState();
    mockBrands = [{ id: 'b_generic', slug: 'generic', isActive: true }];
    mockCategories = [{ id: 'c_household', slug: 'household' }];
    const res = await importProductsFromExcel(
      await buildUpload([{
        name: 'Basic Soap Bar', nameAr: 'صابون أساسي',
        brandSlug: 'generic', categorySlug: 'household',
        sku: 'SOAP-BAR', price: 3, quantity: 50,
      }]),
      'tester',
    );
    expect('1 product created with optional fields blank',
      res.productsCreated === 1 && res.errors.length === 0);
    const created = createCalls[0];
    expect('subcategoryId is null when blank', created?.subcategoryId === null);
    expect('description is undefined when blank', created?.description === undefined);
    expect('barcode is undefined when blank', created?.barcode === undefined);
    expect('isFeatured defaults to false when blank', created?.isFeatured === false);
  });

  await group('11. Header alias tolerance (English Name / Brand / Stock)', async () => {
    resetMockState();
    mockBrands = [{ id: 'b1', slug: 'almarai', isActive: true }];
    mockCategories = [{ id: 'cat1', slug: 'dairy' }];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Aliases');
    ws.addRow(['English Name', 'Arabic Name', 'Brand', 'Category', 'sku', 'price', 'stock']);
    ws.addRow(['Aliased Product', 'منتج بديل', 'almarai', 'dairy', 'ALIAS-1', 9.99, 7]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const res = await importProductsFromExcel(buf, 'tester');
    expect('aliased headers → 1 product created', res.productsCreated === 1 && res.errors.length === 0);
    expect('stock alias maps to quantity (saved as Product.stock)',
      createCalls[0]?.stock === 7);
  });

  console.log(`\n──────────────────────────────────────`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailed assertions:');
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
