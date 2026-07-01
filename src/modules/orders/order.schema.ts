import { z } from 'zod';

export const createOrderSchema = z.object({
  fulfillmentType: z.enum(['DELIVERY', 'PICKUP']).default('DELIVERY'),
  addressId: z.string().optional(),
  paymentMethod: z.enum(['CASH_ON_DELIVERY', 'BANK_TRANSFER', 'PAY_AT_BRANCH']),
  notes: z.string().optional(),
  replacementPreference: z.string().optional(),
  deliveryLat: z.number().min(-90).max(90).optional(),
  deliveryLng: z.number().min(-180).max(180).optional(),
  // Up to 3 delivery-location photo URLs (already uploaded to Bunny).
  deliveryImages: z.array(z.string().url()).max(3).optional(),
  // Scheduled pickup. Only meaningful when fulfillmentType=PICKUP. Server
  // re-validates feature toggle, slot capacity, cutoff, range, etc.
  pickupType: z.enum(['ASAP', 'SCHEDULED']).optional(),
  scheduledPickupDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'scheduledPickupDate must be YYYY-MM-DD')
    .optional(),
  scheduledPickupSlotId: z.string().min(1).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1, 'Order must have at least one item'),
});

export const assignPickerSchema = z.object({
  pickerId: z.string().min(1),
});

export const assignDriverSchema = z.object({
  driverId: z.string().min(1),
});

export const rejectOrderSchema = z.object({
  reason: z.string().min(1),
});

export const updateStatusSchema = z.object({
  status: z.enum([
    'NEW',
    'PAYMENT_VERIFIED',
    'ASSIGNED_TO_PICKER',
    'PICKING_IN_PROGRESS',
    'READY_FOR_DELIVERY',
    'READY_FOR_PICKUP',
    'ASSIGNED_TO_DRIVER',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'PICKED_UP_BY_CUSTOMER',
    'COMPLETED',
    'CONFIRMED',
    'CANCELLED',
    'REJECTED',
  ]),
  note: z.string().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
