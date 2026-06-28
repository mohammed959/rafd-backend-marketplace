import { prisma } from '../../lib/prisma';

// Hard ceiling mirrored from the products API (`product.controller.ts`
// clamps page size to 100). Keeping the same bound here means the admin
// can never configure a value the products endpoint would silently trim.
export const ALL_PRODUCTS_LIMIT_MAX = 100;
export const ALL_PRODUCTS_LIMIT_MIN = 1;
export const ALL_PRODUCTS_LIMIT_DEFAULT = 20;

/**
 * Home settings are a singleton. Read the one row, creating it with
 * defaults on first access so callers always get a concrete value.
 */
export async function getHomeSettings() {
  const existing = await prisma.homeSettings.findFirst();
  if (existing) return existing;
  return prisma.homeSettings.create({ data: {} });
}

export interface UpdateHomeSettingsInput {
  allProductsLimit?: number;
}

export async function updateHomeSettings(data: UpdateHomeSettingsInput) {
  const existing = await prisma.homeSettings.findFirst();
  if (existing) {
    return prisma.homeSettings.update({ where: { id: existing.id }, data });
  }
  return prisma.homeSettings.create({ data });
}
