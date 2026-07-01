import { prisma } from '../../lib/prisma';

export async function getCategories(activeOnly = true, homeOnly = false) {
  return prisma.category.findMany({
    where: {
      ...(activeOnly ? { isActive: true } : {}),
      // Home strip only: active AND flagged to show on home.
      ...(homeOnly ? { showOnHome: true } : {}),
    },
    include: {
      subcategories: {
        where: activeOnly ? { isActive: true } : {},
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function getCategoryById(id: string) {
  return prisma.category.findUnique({
    where: { id },
    include: { subcategories: { orderBy: { sortOrder: 'asc' } } },
  });
}

export async function createCategory(data: {
  name: string;
  nameAr: string;
  slug: string;
  imageUrl?: string;
  sortOrder?: number;
  showOnHome?: boolean;
}) {
  return prisma.category.create({ data });
}

export async function updateCategory(id: string, data: Partial<{
  name: string;
  nameAr: string;
  slug: string;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
  showOnHome: boolean;
}>) {
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(id: string) {
  return prisma.category.delete({ where: { id } });
}

export async function createSubcategory(data: {
  categoryId: string;
  name: string;
  nameAr: string;
  slug: string;
  imageUrl?: string;
  sortOrder?: number;
}) {
  return prisma.subcategory.create({ data });
}

export async function updateSubcategory(id: string, data: Partial<{
  name: string;
  nameAr: string;
  slug: string;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
}>) {
  return prisma.subcategory.update({ where: { id }, data });
}

export async function deleteSubcategory(id: string) {
  return prisma.subcategory.delete({ where: { id } });
}
