import { z } from 'zod';

/**
 * Phase 1 product schema — flat: no variants array.
 *
 * Required: brand, category, price, quantity, sku, names (en+ar).
 * Optional: subcategory, descriptions, barcode, isFeatured, hideFromHome.
 *
 * SKU and barcode are validated at the product level. SKU is unique
 * across products; the DB enforces this via a UNIQUE constraint.
 */
export const createProductSchema = z.object({
  categoryId: z.string().min(1),
  subcategoryId: z.string().optional(),
  brandId: z.string().min(1, 'brandId is required — every product must belong to a brand'),
  name: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  descriptionAr: z.string().max(2000).optional(),
  sku: z.string().min(1).max(64).trim(),
  barcode: z.string().min(1).max(64).trim().optional(),
  price: z.number().positive('price must be > 0'),
  quantity: z.number().int().min(0, 'quantity must be >= 0'),
  isFeatured: z.boolean().optional().default(false),
  hideFromHome: z.boolean().optional().default(false),
});

export const updateProductSchema = createProductSchema.partial();

/**
 * Schema for the dedicated stock-adjust endpoint.
 * `delta` shifts current stock by a signed integer (positive to restock,
 * negative to decrement). Use `set` to overwrite stock to an absolute
 * value. Exactly one must be provided.
 */
export const adjustStockSchema = z
  .object({
    delta: z.number().int().optional(),
    set: z.number().int().min(0).optional(),
  })
  .refine((v) => v.delta !== undefined || v.set !== undefined, {
    message: 'Either `delta` or `set` must be provided',
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
