import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getBrandImageUrl } from '../../lib/productImage';
import { logAction } from '../audit/audit.service';
import { CreateBrandInput, UpdateBrandInput } from './brand.schema';

export interface BrandListOptions {
  search?: string;
  includeInactive?: boolean;
}

/**
 * Brand rows from Prisma carry a NULLable `imageUrl` column that we no
 * longer use as input. Every response funnels through this helper so the
 * caller always sees the Bunny-CDN-derived URL. Top-level brand entities
 * are decorated here; embedded brands inside product responses are
 * decorated by the global response decorator via parent-key dispatch.
 */
type BrandRow = {
  id: string;
  name: string;
  nameAr: string;
  slug: string;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

function attachBrandImage<T extends { slug: string; imageUrl?: string | null }>(brand: T): T & { imageUrl: string } {
  return { ...brand, imageUrl: getBrandImageUrl(brand.slug) };
}

export async function listBrands(opts: BrandListOptions = {}) {
  const { search, includeInactive = false } = opts;
  const where: Prisma.BrandWhereInput = {
    ...(!includeInactive && { isActive: true }),
    ...(search && {
      OR: [
        { name: { contains: search } },
        { nameAr: { contains: search } },
        { slug: { contains: search } },
      ],
    }),
  };
  const rows = await prisma.brand.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(attachBrandImage);
}

export async function getBrandById(id: string) {
  const row = await prisma.brand.findUnique({ where: { id } });
  return row ? attachBrandImage(row) : null;
}

export async function getBrandBySlug(slug: string) {
  const row = await prisma.brand.findUnique({ where: { slug } });
  return row ? attachBrandImage(row) : null;
}

export async function createBrand(data: CreateBrandInput, actorId: string) {
  const existing = await prisma.brand.findUnique({ where: { slug: data.slug } });
  if (existing) throw new Error(`Slug "${data.slug}" is already in use by another brand`);
  const created = await prisma.brand.create({ data });
  await logAction({
    actorId, actorRole: 'SUPER_ADMIN',
    action: 'brand.create', entityType: 'brand', entityId: created.id,
    changes: { name: created.name, slug: created.slug },
  });
  return attachBrandImage(created);
}

export async function updateBrand(id: string, data: UpdateBrandInput, actorId: string) {
  if (data.slug) {
    const clash = await prisma.brand.findFirst({
      where: { slug: data.slug, NOT: { id } },
      select: { id: true },
    });
    if (clash) throw new Error(`Slug "${data.slug}" is already in use by another brand`);
  }
  const updated = await prisma.brand.update({ where: { id }, data });
  await logAction({
    actorId, actorRole: 'SUPER_ADMIN',
    action: 'brand.update', entityType: 'brand', entityId: id,
    changes: data as Record<string, unknown>,
  });
  return attachBrandImage(updated);
}

/**
 * Follows the project's delete-or-deactivate pattern (see
 * `pickup.service.deleteSlot`): if any product still references this
 * brand, soft-disable instead of hard-deleting. Pure delete only when
 * the brand has zero referenced products. This avoids leaving products
 * orphaned while still freeing the slug for reuse when truly unused.
 */
export async function deleteBrand(id: string, actorId: string) {
  const linked = await prisma.product.count({ where: { brandId: id } });

  if (linked > 0) {
    const disabled = await prisma.brand.update({
      where: { id },
      data: { isActive: false },
    });
    await logAction({
      actorId, actorRole: 'SUPER_ADMIN',
      action: 'brand.disable', entityType: 'brand', entityId: id,
      changes: { reason: 'referenced by products', linkedProductCount: linked },
    });
    return {
      id: disabled.id,
      disabledInsteadOfDeleted: true,
      linkedProductCount: linked,
    };
  }

  await prisma.brand.delete({ where: { id } });
  await logAction({
    actorId, actorRole: 'SUPER_ADMIN',
    action: 'brand.delete', entityType: 'brand', entityId: id,
  });
  return { id, disabledInsteadOfDeleted: false, linkedProductCount: 0 };
}

/**
 * Asserts the given id resolves to an active brand. Used by the product
 * service before persisting a new product so we never accept an unknown
 * or disabled brand.
 */
export async function assertBrandExists(brandId: string): Promise<void> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw new Error('Brand not found');
  if (!brand.isActive) throw new Error('Brand is inactive');
}

// Suppress unused-warning while keeping the row type colocated with the
// service (referenced by the test helper that will land in Phase 5).
export type { BrandRow };
