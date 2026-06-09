import { config } from '../config';

const SAFE_PATH_RE = /[^A-Za-z0-9._-]/g;

/**
 * Resolve a product image URL from its SKU.
 * Convention: `${BUNNY_CDN_BASE_URL}/{sku}.{ext}` (default ext: `png`).
 *
 * We do NOT verify the file exists at the CDN — the frontend swaps to the
 * default image on `onError`, which is both cheaper and avoids HEAD storms.
 */
export function getProductImageUrl(sku?: string | null): string {
  if (!sku) return config.bunny.defaultProductImageUrl;
  const trimmed = sku.trim();
  if (!trimmed) return config.bunny.defaultProductImageUrl;
  const safe = trimmed.replace(SAFE_PATH_RE, '_');
  return `${config.bunny.productBaseUrl}/${safe}.${config.bunny.productExtension}`;
}

/**
 * Resolve a category (or subcategory) image URL from its English slug.
 * Convention: `${BUNNY_CATEGORY_BASE_URL}/{slug}.{ext}` (default ext: `png`).
 *
 * The English slug is the URL-safe lowercase identifier we already store on
 * categories (e.g. `dairy`, `beverages`, `snacks`). If the slug is blank,
 * fall back to the default category image.
 */
export function getCategoryImageUrl(slug?: string | null): string {
  if (!slug) return config.bunny.defaultCategoryImageUrl;
  const trimmed = slug.trim();
  if (!trimmed) return config.bunny.defaultCategoryImageUrl;
  const safe = trimmed.toLowerCase().replace(SAFE_PATH_RE, '_');
  return `${config.bunny.categoryBaseUrl}/${safe}.${config.bunny.categoryExtension}`;
}

/**
 * Resolve a brand image URL from its English slug.
 * Convention: `${BUNNY_BRAND_BASE_URL}/{slug}.{ext}` (default ext: `png`).
 *
 * Same strategy as products and categories — the URL is computed, not
 * checked. The frontend's `<img onError>` swaps to the default brand
 * image if the CDN file is missing.
 */
export function getBrandImageUrl(slug?: string | null): string {
  if (!slug) return config.bunny.defaultBrandImageUrl;
  const trimmed = slug.trim();
  if (!trimmed) return config.bunny.defaultBrandImageUrl;
  const safe = trimmed.toLowerCase().replace(SAFE_PATH_RE, '_');
  return `${config.bunny.brandBaseUrl}/${safe}.${config.bunny.brandExtension}`;
}

export const defaultProductImageUrl = (): string => config.bunny.defaultProductImageUrl;
export const defaultCategoryImageUrl = (): string => config.bunny.defaultCategoryImageUrl;
export const defaultBrandImageUrl = (): string => config.bunny.defaultBrandImageUrl;

/**
 * Recursively walk a payload and rewrite every CDN-image-bearing object's
 * `imageUrl` from its identifier:
 *   - product → product.sku (or first variant SKU for legacy rows)
 *   - category / subcategory → slug
 *   - brand → slug (brand namespace, not category)
 *
 * Embedded objects are dispatched via the parent key (`brand`,
 * `category`, `subcategory`) so brands and categories — which share
 * `{slug, name, nameAr}` shape after a `select` — go to the right
 * namespace. Top-level brand list responses are decorated by the brand
 * service itself; the structural `looksLikeCategory` detector is
 * tightened so it no longer false-positives on a brand row.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  const ctorName = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName === 'Decimal') return false;
  if (ctorName === 'Buffer') return false;
  return true;
};

const looksLikeProduct = (obj: Record<string, unknown>) =>
  'name' in obj && (typeof obj.sku === 'string' || Array.isArray(obj.variants));

// Categories carry either a `subcategories` array (parent rows) or a
// `categoryId` string (subcategory rows). Brands have neither.
const looksLikeCategory = (obj: Record<string, unknown>) =>
  typeof obj.slug === 'string' &&
  typeof obj.name === 'string' &&
  !Array.isArray(obj.variants) &&
  (Array.isArray(obj.subcategories) || typeof obj.categoryId === 'string');

const looksLikeVariantRow = (obj: Record<string, unknown>) =>
  typeof obj.sku === 'string' && isPlainObject(obj.product);

function decorate(payload: unknown, parentKey?: string): unknown {
  if (Array.isArray(payload)) {
    return payload.map((p) => decorate(p, parentKey));
  }
  if (!isPlainObject(payload)) return payload;

  const obj = payload as Record<string, unknown>;

  // Parent-key dispatch — disambiguates brand from category/subcategory
  // when a `select` strips the structural cues.
  if (parentKey === 'brand' && typeof obj.slug === 'string') {
    obj.imageUrl = getBrandImageUrl(obj.slug);
  } else if ((parentKey === 'category' || parentKey === 'subcategory') && typeof obj.slug === 'string') {
    obj.imageUrl = getCategoryImageUrl(obj.slug);
  } else if (looksLikeVariantRow(obj)) {
    const sku = obj.sku as string;
    const product = obj.product as Record<string, unknown>;
    obj.product = { ...product, imageUrl: getProductImageUrl(sku) };
  } else if (looksLikeProduct(obj)) {
    const flatSku = typeof obj.sku === 'string' ? obj.sku : undefined;
    const variants = Array.isArray(obj.variants) ? (obj.variants as Array<{ sku?: string }>) : [];
    obj.imageUrl = getProductImageUrl(flatSku ?? variants[0]?.sku);
  } else if (looksLikeCategory(obj)) {
    obj.imageUrl = getCategoryImageUrl(obj.slug as string);
  }

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') {
      obj[key] = decorate(v, key);
    }
  }
  return obj;
}

export function decorateProductImages<T>(payload: T): T {
  return decorate(payload) as T;
}
