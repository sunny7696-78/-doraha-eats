import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type SignedUpload = {
  uploadUrl: string;
  /** HTTP method the app must use. */
  method: 'PUT';
  /** Headers the app MUST send unchanged, or the storage service rejects the upload. */
  headers: Record<string, string>;
  publicUrl: string;
  maxBytes: number;
};

export interface StorageProvider {
  signedUpload(key: string, contentType: string, sizeBytes?: number): Promise<SignedUpload>;
  /** Base that every stored file's public URL starts with (no trailing slash). */
  publicBase(): string;
}

/** Local dev: files are served from /uploads by the API. No cloud account needed. */
const localProvider: StorageProvider = {
  async signedUpload(key, contentType) {
    return { uploadUrl: `/uploads/${key}`, method: 'PUT', headers: { 'Content-Type': contentType },
      publicUrl: `/uploads/${key}`, maxBytes: MAX_UPLOAD_BYTES };
  },
  publicBase: () => '/uploads',
};

/**
 * S3 or any S3-compatible service (Cloudflare R2, Backblaze B2, DigitalOcean Spaces).
 * The app uploads straight to the bucket with a short-lived signed URL, so image bytes
 * never pass through (or live on) the API server. The signature covers the content type
 * AND exact size, so the bucket rejects a different file type or an oversized upload.
 */
let s3: S3Client | null = null;
const s3Provider: StorageProvider = {
  async signedUpload(key, contentType, sizeBytes) {
    if (!sizeBytes || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppError(400, 'INVALID_FILE_SIZE', 'Images must be between 1 byte and 5 MB.');
    }
    s3 ??= new S3Client({
      region: env.S3_REGION ?? 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
      forcePathStyle: !!env.S3_ENDPOINT,
    });
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.S3_BUCKET, Key: key, ContentType: contentType, ContentLength: sizeBytes,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      uploadUrl, method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes),
        'Cache-Control': 'public, max-age=31536000, immutable' },
      publicUrl: `${s3Provider.publicBase()}/${key}`, maxBytes: MAX_UPLOAD_BYTES,
    };
  },
  publicBase: () => (env.S3_PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
};

export const storageProvider: StorageProvider = env.STORAGE_PROVIDER === 's3' ? s3Provider : localProvider;

/** True only for a URL this API issued for THIS vendor — blocks arbitrary external image URLs. */
export function isOwnUploadUrl(vendorId: string, url: string | null | undefined): boolean {
  if (!url) return true; // clearing an image is fine
  return url.startsWith(`${storageProvider.publicBase()}/vendors/${vendorId}/`) && !url.includes('..');
}
