import { config } from '../config';

/**
 * Bunny Storage upload helper. Customer images are PUT into the Storage Zone
 * (`config.bunny.storageZone`) and served back over the public Pull Zone
 * (`config.bunny.publicBaseUrl`). We store only the resulting CDN URL in the
 * database — never the image bytes — to keep the DB light.
 */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isSupportedImageMime(mime: string): boolean {
  return mime in EXT_BY_MIME;
}

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'jpg';
}

function assertConfigured(): void {
  if (!config.bunny.storageZone || !config.bunny.storageAccessKey) {
    throw new Error(
      'Image storage is not configured. Set BUNNY_STORAGE_ZONE_NAME and BUNNY_STORAGE_ACCESS_KEY.',
    );
  }
}

/**
 * Upload a buffer to the Storage Zone at `objectPath` (relative, no leading
 * slash). Returns the public CDN URL used to fetch it.
 */
export async function uploadBuffer(
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  assertConfigured();
  const path = objectPath.replace(/^\/+/, '');
  const url = `https://${config.bunny.storageHost}/${config.bunny.storageZone}/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: config.bunny.storageAccessKey,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Image upload failed (${res.status}). ${detail}`.trim());
  }
  return `${config.bunny.publicBaseUrl}/${path}`;
}

/**
 * Best-effort delete of an object given its public CDN URL. Silently ignores
 * URLs that don't belong to our zone and any network/404 errors — orphaned
 * files are harmless and we never want a cleanup failure to break the flow.
 */
export async function deleteByPublicUrl(publicUrl: string): Promise<void> {
  if (!config.bunny.storageZone || !config.bunny.storageAccessKey) return;
  const prefix = `${config.bunny.publicBaseUrl}/`;
  if (!publicUrl.startsWith(prefix)) return;
  const path = publicUrl.slice(prefix.length);
  const url = `https://${config.bunny.storageHost}/${config.bunny.storageZone}/${path}`;
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: { AccessKey: config.bunny.storageAccessKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* best-effort — ignore */
  }
}
