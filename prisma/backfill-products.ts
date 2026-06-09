/**
 * One-time, idempotent backfill for Phase 1 of the variant-removal effort.
 *
 * What it does:
 *   1. Ensures a "Generic" brand exists and assigns it to every product
 *      whose `brandId` is NULL.
 *   2. For every product whose flat commerce fields (`sku`, `price`,
 *      `stock`) are still NULL, picks a canonical variant — preferring
 *      type=PIECE, otherwise the lowest-price active variant — and copies
 *      `sku`, `barcode`, `price`, `stock`, `reserved` onto the product row.
 *
 * What it does NOT do:
 *   - Touch `product_variants` rows.
 *   - Touch `order_items.variantId` — historical orders still resolve
 *     through the existing FK.
 *   - Delete anything.
 *
 * Safe to re-run: every step is guarded by NULL checks, and the SKU
 * UNIQUE constraint protects against accidental duplicate writes (if
 * two products share a canonical SKU, the second update will fail and
 * the row is reported as a conflict).
 *
 * Run:
 *   pnpm --filter backend run backfill:products
 *   # or
 *   ts-node prisma/backfill-products.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_BRAND = {
  name: 'Generic',
  nameAr: 'عام',
  slug: 'generic',
};

async function ensureDefaultBrand() {
  const existing = await prisma.brand.findUnique({ where: { slug: DEFAULT_BRAND.slug } });
  if (existing) return existing;
  return prisma.brand.create({
    data: {
      name: DEFAULT_BRAND.name,
      nameAr: DEFAULT_BRAND.nameAr,
      slug: DEFAULT_BRAND.slug,
      sortOrder: 0,
      isActive: true,
    },
  });
}

async function assignDefaultBrand(brandId: string) {
  const result = await prisma.product.updateMany({
    where: { brandId: null },
    data: { brandId },
  });
  return result.count;
}

async function backfillFlatFields() {
  // Pull every product that still needs flattening. We deliberately bypass
  // `orderBy: createdAt` here so the script behaves the same on a freshly
  // restored DB as on the production one.
  const pending = await prisma.product.findMany({
    where: { OR: [{ sku: null }, { price: null }] },
    include: {
      variants: {
        where: { isActive: true },
        orderBy: { price: 'asc' },
      },
    },
  });

  let updated = 0;
  let skippedNoVariant = 0;
  const conflicts: { productId: string; sku: string; error: string }[] = [];

  for (const product of pending) {
    if (product.variants.length === 0) {
      skippedNoVariant += 1;
      continue;
    }
    // Prefer PIECE; otherwise the cheapest active variant (already first
    // due to the orderBy: { price: 'asc' } above).
    const canonical =
      product.variants.find((v) => v.type === 'PIECE') ?? product.variants[0];

    try {
      await prisma.product.update({
        where: { id: product.id },
        data: {
          sku: product.sku ?? canonical.sku,
          barcode: product.barcode ?? canonical.barcode,
          price: product.price ?? canonical.price,
          // `stock`/`reserved` are NOT NULL with default 0, so only
          // overwrite when the product still reads as untouched (stock 0
          // AND reserved 0 AND no flat sku) — guards against re-runs
          // clobbering a legitimately depleted stock figure.
          ...(product.stock === 0 && product.reserved === 0 && product.sku === null && {
            stock: canonical.stock,
            reserved: canonical.reserved,
          }),
        },
      });
      updated += 1;
    } catch (err) {
      conflicts.push({
        productId: product.id,
        sku: canonical.sku,
        error: (err as Error).message,
      });
    }
  }

  return { updated, skippedNoVariant, conflicts };
}

async function main() {
  console.log('[backfill] Step 1/2 — ensuring default brand');
  const brand = await ensureDefaultBrand();
  const assigned = await assignDefaultBrand(brand.id);
  console.log(`[backfill]   default brand id=${brand.id} (slug=${brand.slug}); assigned to ${assigned} product(s)`);

  console.log('[backfill] Step 2/2 — flattening canonical variant into product');
  const result = await backfillFlatFields();
  console.log(`[backfill]   updated: ${result.updated}`);
  console.log(`[backfill]   skipped (product has no active variant): ${result.skippedNoVariant}`);
  if (result.conflicts.length > 0) {
    console.warn(`[backfill]   conflicts (${result.conflicts.length}) — resolve manually:`);
    for (const c of result.conflicts) {
      console.warn(`    productId=${c.productId} sku=${c.sku} reason=${c.error}`);
    }
  }
  console.log('[backfill] done');
}

main()
  .catch((err) => {
    console.error('[backfill] FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
