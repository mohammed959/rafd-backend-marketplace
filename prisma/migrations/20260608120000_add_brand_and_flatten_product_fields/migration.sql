-- ─── Phase 1: flatten product, introduce Brand ─────────────────────
-- Strictly additive. No data is dropped, no existing column is altered
-- in a destructive way. Variant rows and the order_items.variantId FK
-- remain untouched so historical orders keep resolving. New columns on
-- `products` are nullable so the migration applies on a non-empty DB
-- without violating any NOT NULL constraint; the application layer
-- requires them for newly created products, and
-- `prisma/backfill-products.ts` populates them for legacy rows.

-- CreateTable: brands
CREATE TABLE `brands` (
  `id`         VARCHAR(191) NOT NULL,
  `name`       VARCHAR(191) NOT NULL,
  `nameAr`     VARCHAR(191) NOT NULL,
  `slug`       VARCHAR(191) NOT NULL,
  `imageUrl`   TEXT NULL,
  `isActive`   BOOLEAN      NOT NULL DEFAULT true,
  `sortOrder`  INT          NOT NULL DEFAULT 0,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex: brands
CREATE UNIQUE INDEX `brands_slug_key` ON `brands`(`slug`);
CREATE INDEX        `brands_isActive_idx` ON `brands`(`isActive`);

-- AlterTable: products — add brand/sku/barcode/price/stock/reserved
ALTER TABLE `products`
  ADD COLUMN `brandId`  VARCHAR(191) NULL,
  ADD COLUMN `sku`      VARCHAR(191) NULL,
  ADD COLUMN `barcode`  VARCHAR(191) NULL,
  ADD COLUMN `price`    DECIMAL(10, 2) NULL,
  ADD COLUMN `stock`    INT NOT NULL DEFAULT 0,
  ADD COLUMN `reserved` INT NOT NULL DEFAULT 0;

-- AddForeignKey: products.brandId -> brands.id
ALTER TABLE `products`
  ADD CONSTRAINT `products_brandId_fkey`
  FOREIGN KEY (`brandId`)
  REFERENCES `brands`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: products.sku unique + helper indexes
CREATE UNIQUE INDEX `products_sku_key`     ON `products`(`sku`);
CREATE INDEX        `products_barcode_idx` ON `products`(`barcode`);
CREATE INDEX        `products_brandId_idx` ON `products`(`brandId`);
