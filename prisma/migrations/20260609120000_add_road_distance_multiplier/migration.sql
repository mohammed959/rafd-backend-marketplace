-- Add an admin-controllable multiplier so the great-circle (haversine)
-- distance can be calibrated against observed driving distances without
-- needing an external routing API. Default 1.00 keeps existing behavior.

ALTER TABLE `delivery_pricing_settings`
  ADD COLUMN `roadDistanceMultiplier` DECIMAL(4, 2) NOT NULL DEFAULT 1.00;
