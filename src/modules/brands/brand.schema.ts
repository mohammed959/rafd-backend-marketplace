import { z } from 'zod';

/**
 * Admin input for brand CRUD. The brand image is NOT a user-controlled
 * field — it's derived from the slug at response time, following the
 * Bunny CDN convention used for products and categories
 * (`/brand/{slug}.png`, with a default fallback on the frontend).
 */
export const createBrandSchema = z.object({
  name: z.string().min(1, 'name is required').max(120).trim(),
  nameAr: z.string().min(1, 'nameAr is required').max(120).trim(),
  slug: z
    .string()
    .min(1, 'slug is required')
    .max(120)
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'slug must be url-safe: lowercase letters, digits, hyphens only'),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).optional().default(0),
});

export const updateBrandSchema = createBrandSchema.partial();

export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
