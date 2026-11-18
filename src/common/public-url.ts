import type { Request } from 'express';

const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/;

/**
 * The address students' apps reach this server on, for download links.
 *
 * Behind Render's proxy the app sees `http` unless the proxy is trusted, and
 * Android release builds refuse plain-http downloads ("Couldn't download this
 * file"). So: PUBLIC_API_URL if set; else the forwarded protocol; and never
 * `http` for a real (non-local) host.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.get('x-forwarded-host')?.split(',')[0].trim() || req.get('host') || 'localhost';
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0].trim();
  let protocol = forwarded || req.protocol || 'https';
  if (protocol !== 'https' && !LOCAL_HOST.test(host)) protocol = 'https';
  return `${protocol}://${host}`;
}
