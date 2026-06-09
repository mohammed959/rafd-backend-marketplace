-- ─── Phase 6: flatten OrderItem onto Product ───────────────────────
-- Non-destructive transition:
--   • `variantId` becomes NULLABLE so new flat orders can omit it.
--     Legacy rows keep their value and continue to resolve via the
--     existing variant FK.
--   • Five new columns add the product-keyed write path and a snapshot
--     of SKU/barcode/name so historical rows still render if the
--     product is later renamed or deleted.
--   • New FK: order_items.productId → products(id) ON DELETE SET NULL
--     (mirrors the existing variant FK semantics — orphan an item, do
--     not cascade-delete it).
-- No data is dropped, no FK is removed.

-- AlterTable: relax NOT NULL on variantId for legacy/new coexistence.
ALTER TABLE `order_items`
  MODIFY COLUMN `variantId` VARCHAR(191) NULL;

-- AlterTable: add product-keyed columns + snapshot fields.
ALTER TABLE `order_items`
  ADD COLUMN `productId`     VARCHAR(191) NULL,
  ADD COLUMN `productSku`    VARCHAR(191) NULL,
  ADD COLUMN `productBarcode` VARCHAR(191) NULL,
  ADD COLUMN `productName`   VARCHAR(191) NULL,
  ADD COLUMN `productNameAr` VARCHAR(191) NULL;

-- AddForeignKey: products.id ← order_items.productId
ALTER TABLE `order_items`
  ADD CONSTRAINT `order_items_productId_fkey`
  FOREIGN KEY (`productId`)
  REFERENCES `products`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX `order_items_productId_idx` ON `order_items`(`productId`);
