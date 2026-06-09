import dotenv from 'dotenv';
dotenv.config();

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, '');

export const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
  otp: {
    expiresMinutes: parseInt(process.env.OTP_EXPIRES_MINUTES ?? '5', 10),
    // TEMPORARY: when set, every generated customer OTP is forced to this
    // value (e.g. "123456") so testers can sign in without SMS. Unset in
    // production to restore random per-request OTPs.
    override: process.env.DEV_OTP_OVERRIDE?.trim() || null,
  },
  bunny: {
    // Products: ${productBaseUrl}/{sku}.${productExtension}
    productBaseUrl: stripTrailingSlash(
      process.env.BUNNY_CDN_BASE_URL ?? 'https://your-zone.b-cdn.net/products'
    ),
    productExtension: (process.env.BUNNY_PRODUCT_IMAGE_EXT ?? 'png').replace(/^\./, ''),
    defaultProductImageUrl:
      process.env.DEFAULT_PRODUCT_IMAGE_URL ??
      'https://your-zone.b-cdn.net/products/default/default.png',

    // Categories: ${categoryBaseUrl}/{english-slug}.${categoryExtension}
    categoryBaseUrl: stripTrailingSlash(
      process.env.BUNNY_CATEGORY_BASE_URL ?? 'https://your-zone.b-cdn.net/category'
    ),
    categoryExtension: (process.env.BUNNY_CATEGORY_IMAGE_EXT ?? 'png').replace(/^\./, ''),
    defaultCategoryImageUrl:
      process.env.DEFAULT_CATEGORY_IMAGE_URL ??
      'https://your-zone.b-cdn.net/category/default/default.png',

    // Brands: ${brandBaseUrl}/{english-slug}.${brandExtension}
    brandBaseUrl: stripTrailingSlash(
      process.env.BUNNY_BRAND_BASE_URL ?? 'https://your-zone.b-cdn.net/brand'
    ),
    brandExtension: (process.env.BUNNY_BRAND_IMAGE_EXT ?? 'png').replace(/^\./, ''),
    defaultBrandImageUrl:
      process.env.DEFAULT_BRAND_IMAGE_URL ??
      'https://your-zone.b-cdn.net/brand/default/default.png',
  },
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
};
