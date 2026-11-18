import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { avatarUrlForKey } from '../avatars/avatar-view';

/**
 * Where uploaded study materials (slides, textbooks, notes) are kept.
 *
 * - STORAGE_BUCKET set → any S3-compatible store (Cloudflare R2, AWS S3, …):
 *   STORAGE_ENDPOINT (R2: https://<account-id>.r2.cloudflarestorage.com),
 *   STORAGE_REGION (R2: auto), STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.
 * - Otherwise, outside production → local disk (UPLOAD_DIR, default a temp
 *   folder), served by FilesController with short-lived signed links.
 * - Otherwise uploads are switched off; admins can still add links.
 *
 * Downloads always go through short-lived signed URLs, never public links —
 * except profile pictures under `avatars/`, which are public by design: in
 * production that prefix is exposed through a CDN domain (STORAGE_PUBLIC_URL,
 * e.g. https://cdn.edmira.org/), locally FilesController serves it.
 */
export interface StoredFile {
  key: string;
  name: string;
  size: number;
  mimeType: string;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** PDFs, slides, documents and e-books. */
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.epub': 'application/epub+zip',
};

const LINK_TTL_SECONDS = 15 * 60;

@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly bucket = process.env.STORAGE_BUCKET;
  private readonly driver: 's3' | 'local' | 'off' = this.bucket
    ? 's3'
    : process.env.NODE_ENV === 'production'
      ? 'off'
      : 'local';
  private readonly localDir = process.env.UPLOAD_DIR || join(tmpdir(), 'edmira-uploads');
  private readonly signingSecret = process.env.JWT_SECRET ?? 'edmira-files';
  private s3?: S3Client;

  constructor() {
    if (this.driver === 's3') {
      this.s3 = new S3Client({
        region: process.env.STORAGE_REGION || 'auto',
        endpoint: process.env.STORAGE_ENDPOINT || undefined,
        forcePathStyle: !!process.env.STORAGE_ENDPOINT,
        credentials: {
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
        },
      });
    }
    this.logger.log(`File storage: ${this.driver}${this.driver === 'local' ? ` (${this.localDir})` : ''}`);
  }

  get uploadsEnabled() {
    return this.driver !== 'off';
  }

  async save(file: { originalname: string; buffer: Buffer; size: number }): Promise<StoredFile> {
    if (this.driver === 'off') {
      throw new ServiceUnavailableException(
        "File uploads aren't set up on this server yet. Add the material as a link instead.",
      );
    }
    // Multer reads multipart filenames as Latin-1; browsers send UTF-8.
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = extname(name).toLowerCase();
    const mimeType = ALLOWED_UPLOAD_TYPES[ext];
    const key = `materials/${randomUUID()}${ext}`;
    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file.buffer, ContentType: mimeType }),
      );
    } else {
      await fs.mkdir(join(this.localDir, 'materials'), { recursive: true });
      await fs.writeFile(join(this.localDir, key), file.buffer);
    }
    return { key, name, size: file.size, mimeType };
  }

  /** A link the app / dashboard can fetch for the next 15 minutes. */
  async signedUrl(file: StoredFile, baseUrl: string): Promise<{ url: string; expiresAt: string }> {
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const expiresAt = new Date(expires * 1000).toISOString();
    const disposition = `attachment; filename="${file.name.replace(/"/g, '')}"`;
    if (this.driver === 's3') {
      const url = await getSignedUrl(
        this.s3!,
        new GetObjectCommand({ Bucket: this.bucket, Key: file.key, ResponseContentDisposition: disposition }),
        { expiresIn: LINK_TTL_SECONDS },
      );
      return { url, expiresAt };
    }
    const sig = this.sign(file.key, expires);
    const url = `${baseUrl}/api/v1/files/${file.key}?exp=${expires}&sig=${sig}&name=${encodeURIComponent(file.name)}`;
    return { url, expiresAt };
  }

  // ── Public files (profile pictures) ────────────────────────────────────────

  /** Stores a public object such as `avatars/<uuid>.webp`. */
  async savePublic(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!/^avatars\/[\w-]+\.\w+$/.test(key)) throw new Error(`Not a public key: ${key}`);
    if (this.driver === 'off') {
      throw new ServiceUnavailableException("Photo uploads aren't set up on this server yet. Pick an avatar instead.");
    }
    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Every change gets a new filename, so the file itself never changes.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return;
    }
    await fs.mkdir(join(this.localDir, 'avatars'), { recursive: true });
    await fs.writeFile(join(this.localDir, key), body);
  }

  /** Best effort: a leftover file is harmless, a failed request is not. */
  async deletePublic(key: string | undefined | null): Promise<void> {
    if (!key || !/^avatars\/[\w-]+\.\w+$/.test(key)) return;
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } else if (this.driver === 'local') {
        await fs.unlink(join(this.localDir, key));
      }
    } catch (err) {
      this.logger.warn(`Could not delete ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Public URL of a stored avatar. With a CDN it is absolute; locally it is
   * relative to the API host (`/api/v1/files/avatars/…`) and the app prefixes
   * its own server address.
   */
  publicUrl(key: string): string {
    return avatarUrlForKey(key);
  }

  /** Path of a locally stored avatar, or null. */
  localPublicPath(file: string): string | null {
    if (this.driver !== 'local' || !/^[\w-]+\.webp$/.test(file)) return null;
    return join(this.localDir, 'avatars', file);
  }

  // ── Local driver ───────────────────────────────────────────────────────────

  private sign(key: string, expires: number) {
    return createHmac('sha256', this.signingSecret).update(`${key}:${expires}`).digest('hex');
  }

  /** Path of a local file if the signed link is valid, else null. */
  localPath(key: string, expires: number, sig: string): string | null {
    if (this.driver !== 'local' || !/^materials\/[\w-]+\.\w+$/.test(key)) return null;
    if (!Number.isFinite(expires) || expires < Date.now() / 1000) return null;
    const expected = Buffer.from(this.sign(key, expires));
    const given = Buffer.from(sig ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return join(this.localDir, key);
  }
}
