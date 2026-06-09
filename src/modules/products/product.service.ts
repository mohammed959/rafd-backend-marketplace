import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { assertBrandExists } from '../brands/brand.service';
import {
  AdjustStockInput,
  CreateProductInput,
  UpdateProductInput,
} from './product.schema';

/**
 * Standard paginated payload. Returns the new ninja-style fields
 * (pageSize/totalItems/totalPages/hasNextPage/hasPreviousPage) plus the legacy
 * shape (page/limit/total/pages) so we don't break clients still reading
 * those.
 */
export function buildPagination(page: number, limit: number, total: number) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    pageSize: limit,
    totalItems: total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    limit,
    total,
    pages: totalPages,
  };
}

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, nameAr: true, slug: true } },
  subcategory: { select: { id: true, name: true, nameAr: true, slug: true } },
  brand: { select: { id: true, name: true, nameAr: true, slug: true } },
} as const;

export interface ProductListOptions {
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
  featured?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  includeOutOfStock?: boolean;
  includeInactive?: boolean;
  excludeHiddenFromHome?: boolean;
}

/**
 * Phase 1 list: filters now run against product-level fields. The OOS gate
 * uses `product.stock - product.reserved > 0` so legacy products that have
 * not been backfilled yet are excluded from customer browsing (their stock
 * defaults to 0 until the backfill script copies values from the canonical
 * variant).
 */
export async function listProducts(opts: ProductListOptions = {}) {
  const {
    categoryId,
    subcategoryId,
    brandId,
    featured,
    search,
    page = 1,
    limit = 20,
    includeOutOfStock = false,
    includeInactive = false,
    excludeHiddenFromHome = false,
  } = opts;

  const where: Prisma.ProductWhereInput = {
    ...(!includeInactive && { isActive: true }),
    ...(excludeHiddenFromHome && { hideFromHome: false }),
    ...(categoryId && { categoryId }),
    ...(subcategoryId && { subcategoryId }),
    ...(brandId && { brandId }),
    ...(featured !== undefined && { isFeatured: featured }),
    ...(search && {
      OR: [
        { name: { contains: search } },
        { nameAr: { contains: search } },
        { sku: { contains: search } },
        { barcode: { contains: search } },
      ],
    }),
    // Browsing hides products with zero available stock; admin / search bypasses this.
    ...(!includeInactive && !includeOutOfStock && {
      stock: { gt: 0 },
    }),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      include: PRODUCT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    products: products.map(annotateAvailability),
    pagination: buildPagination(page, limit, total),
  };
}

export async function getProductById(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: PRODUCT_INCLUDE,
  });
  return product ? annotateAvailability(product) : null;
}

export async function createProduct(data: CreateProductInput) {
  await assertBrandExists(data.brandId);
  await ensureSkuUnique(data.sku);
  return prisma.product.create({
    data: {
      categoryId: data.categoryId,
      subcategoryId: data.subcategoryId,
      brandId: data.brandId,
      name: data.name,
      nameAr: data.nameAr,
      description: data.description,
      descriptionAr: data.descriptionAr,
      sku: data.sku,
      barcode: data.barcode,
      price: data.price,
      stock: data.quantity,
      isFeatured: data.isFeatured,
      hideFromHome: data.hideFromHome,
    },
    include: PRODUCT_INCLUDE,
  });
}

export async function updateProduct(id: string, data: UpdateProductInput) {
  if (data.brandId) await assertBrandExists(data.brandId);
  if (data.sku) await ensureSkuUnique(data.sku, id);

  const payload: Prisma.ProductUpdateInput = {};
  if (data.categoryId !== undefined) payload.category = { connect: { id: data.categoryId } };
  if (data.subcategoryId !== undefined) {
    payload.subcategory = data.subcategoryId
      ? { connect: { id: data.subcategoryId } }
      : { disconnect: true };
  }
  if (data.brandId !== undefined) payload.brand = { connect: { id: data.brandId } };
  if (data.name !== undefined) payload.name = data.name;
  if (data.nameAr !== undefined) payload.nameAr = data.nameAr;
  if (data.description !== undefined) payload.description = data.description;
  if (data.descriptionAr !== undefined) payload.descriptionAr = data.descriptionAr;
  if (data.sku !== undefined) payload.sku = data.sku;
  if (data.barcode !== undefined) payload.barcode = data.barcode;
  if (data.price !== undefined) payload.price = data.price;
  if (data.quantity !== undefined) payload.stock = data.quantity;
  if (data.isFeatured !== undefined) payload.isFeatured = data.isFeatured;
  if (data.hideFromHome !== undefined) payload.hideFromHome = data.hideFromHome;

  return prisma.product.update({
    where: { id },
    data: payload,
    include: PRODUCT_INCLUDE,
  });
}

export async function toggleProductStatus(id: string, isActive: boolean) {
  return prisma.product.update({ where: { id }, data: { isActive } });
}

export async function deleteProduct(id: string) {
  return prisma.product.delete({ where: { id } });
}

/**
 * Adjust stock at the product level. Supports either a signed `delta`
 * (increment/decrement) or an absolute `set` value. Stock cannot go
 * negative when using `delta`.
 */
export async function adjustProductStock(productId: string, input: AdjustStockInput) {
  if (input.set !== undefined) {
    return prisma.product.update({
      where: { id: productId },
      data: { stock: input.set },
    });
  }
  const delta = input.delta!;
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id: productId }, select: { stock: true } });
    if (!current) throw new Error('Product not found');
    const next = current.stock + delta;
    if (next < 0) throw new Error('Stock cannot go negative');
    return tx.product.update({ where: { id: productId }, data: { stock: next } });
  });
}

export async function getFeaturedProducts() {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      isFeatured: true,
      stock: { gt: 0 },
    },
    include: PRODUCT_INCLUDE,
    take: 20,
  });
  return products.map(annotateAvailability);
}

// ─── Smart search ──────────────────────────────────────────────────

type ProductWithStock = {
  stock: number;
  reserved: number;
  isActive: boolean;
};

const annotateAvailability = <P extends ProductWithStock>(product: P): P & { available: boolean } => {
  const available = product.isActive && product.stock - product.reserved > 0;
  return { ...product, available };
};

export async function searchProducts(opts: {
  q?: string;
  barcode?: string;
  page?: number;
  limit?: number;
}) {
  const { q, barcode } = opts;
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));

  // Barcode lookup: exact match against the product-level barcode. Single result
  // by design — barcodes are practically unique even though we don't enforce it
  // in SQL (some products share GS1 lookups via packaging).
  if (barcode && barcode.trim()) {
    const product = await prisma.product.findFirst({
      where: { barcode: barcode.trim(), isActive: true },
      include: PRODUCT_INCLUDE,
    });
    if (!product) {
      return {
        products: [],
        matchedProductId: null,
        pagination: buildPagination(1, limit, 0),
      };
    }
    return {
      products: [annotateAvailability(product)],
      matchedProductId: product.id,
      pagination: buildPagination(1, limit, 1),
    };
  }

  const term = (q ?? '').trim();
  if (!term) {
    return {
      products: [],
      matchedProductId: null,
      pagination: buildPagination(page, limit, 0),
    };
  }

  const where: Prisma.ProductWhereInput = {
    isActive: true,
    OR: [
      { name: { contains: term } },
      { nameAr: { contains: term } },
      { sku: { contains: term } },
      { barcode: { contains: term } },
    ],
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      include: PRODUCT_INCLUDE,
      orderBy: [{ isFeatured: 'desc' }, { id: 'asc' }],
    }),
    prisma.product.count({ where }),
  ]);

  const annotated = products.map(annotateAvailability);
  annotated.sort((a, b) => Number(b.available) - Number(a.available));

  return {
    products: annotated,
    matchedProductId: null,
    pagination: buildPagination(page, limit, total),
  };
}

export async function listLowStockProducts(threshold = 5) {
  return prisma.product.findMany({
    where: {
      isActive: true,
      stock: { lte: threshold },
    },
    include: {
      category: { select: { id: true, name: true, nameAr: true } },
      brand: { select: { id: true, name: true, nameAr: true } },
    },
    orderBy: { stock: 'asc' },
    take: 100,
  });
}

export async function searchSuggestions(q: string, limit = 8) {
  const term = q.trim();
  if (!term) return [];
  return prisma.product.findMany({
    where: {
      isActive: true,
      OR: [
        { name: { contains: term } },
        { nameAr: { contains: term } },
      ],
    },
    select: { id: true, name: true, nameAr: true, imageUrl: true, sku: true },
    take: limit,
    orderBy: { isFeatured: 'desc' },
  });
}

// ─── Internal helpers ──────────────────────────────────────────────

async function ensureSkuUnique(sku: string, ignoreProductId?: string): Promise<void> {
  const existing = await prisma.product.findFirst({
    where: {
      sku,
      ...(ignoreProductId && { NOT: { id: ignoreProductId } }),
    },
    select: { id: true },
  });
  if (existing) throw new Error(`SKU "${sku}" is already in use by another product`);
}
