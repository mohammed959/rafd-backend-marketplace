import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { errorMiddleware } from './middleware/error.middleware';

import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import categoryRoutes from './modules/categories/category.routes';
import productRoutes from './modules/products/product.routes';
import brandRoutes from './modules/brands/brand.routes';
import orderRoutes from './modules/orders/order.routes';
import deliveryRoutes from './modules/delivery/delivery.routes';
import subscriptionRoutes from './modules/subscriptions/subscription.routes';
import notificationRoutes from './modules/notifications/notification.routes';
import addressRoutes from './modules/addresses/address.routes';
import favoriteRoutes from './modules/favorites/favorite.routes';
import bannerRoutes from './modules/banners/banner.routes';
import featuredSectionRoutes from './modules/featured-sections/featuredSection.routes';
import promotionRoutes from './modules/promotions/promotion.routes';
import auditRoutes from './modules/audit/audit.routes';
import bulkSkuRoutes from './modules/bulk-sku-update/bulkSku.routes';
import checkoutRoutes from './modules/checkout/checkout.routes';
import pickupRoutes from './modules/pickup/pickup.routes';

const app = express();

// Security
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));

// Rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Logging & parsing
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/featured-sections', featuredSectionRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/inventory-bulk', bulkSkuRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/pickup', pickupRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use(errorMiddleware);

export default app;
