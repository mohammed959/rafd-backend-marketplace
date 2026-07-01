import { randomUUID } from 'crypto';
import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { ok, badRequest } from '../../lib/response';
import { uploadBuffer, isSupportedImageMime, extForMime } from '../../lib/bunnyStorage';
import { config } from '../../config';

/**
 * Upload a single customer delivery-location image to Bunny Storage under
 * `Customers/{customerId}/{uuid}.{ext}` and return its public CDN URL. The
 * caller (checkout / order page) collects up to 3 of these URLs and attaches
 * them to the order — no image bytes are stored in our database.
 */
export async function uploadDeliveryImage(req: AuthRequest, res: Response): Promise<void> {
  const file = (req as { file?: { buffer: Buffer; mimetype: string } }).file;
  if (!file) {
    badRequest(res, 'No image uploaded (field name: file).');
    return;
  }
  if (!isSupportedImageMime(file.mimetype)) {
    badRequest(res, 'Only JPG, PNG or WEBP images are allowed.');
    return;
  }

  const customerId = req.user!.userId;
  const path = `${config.bunny.customerFolder}/${customerId}/${randomUUID()}.${extForMime(file.mimetype)}`;

  try {
    const url = await uploadBuffer(path, file.buffer, file.mimetype);
    ok(res, { url }, 'Image uploaded');
  } catch (err) {
    badRequest(res, (err as Error).message || 'Upload failed');
  }
}
