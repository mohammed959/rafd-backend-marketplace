-- DropForeignKey
ALTER TABLE `order_items` DROP FOREIGN KEY `order_items_variantId_fkey`;

-- CreateTable
CREATE TABLE `home_settings` (
    `id` VARCHAR(191) NOT NULL,
    `allProductsLimit` INTEGER NOT NULL DEFAULT 20,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
