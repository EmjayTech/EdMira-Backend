import type { Request } from 'express';
import { publicBaseUrl } from './public-url';

const req = (headers: Record<string, string>, protocol = 'http') =>
  ({ protocol, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

describe('download links', () => {
  afterEach(() => delete process.env.PUBLIC_API_URL);

  it('never gives a real host an http link (Android blocks those)', () => {
    expect(publicBaseUrl(req({ host: 'edmira-backend.onrender.com' }))).toBe('https://edmira-backend.onrender.com');
    expect(publicBaseUrl(req({ host: 'edmira-backend.onrender.com', 'x-forwarded-proto': 'http' }))).toBe('https://edmira-backend.onrender.com');
  });

  it('keeps http for local development', () => {
    expect(publicBaseUrl(req({ host: 'localhost:4000' }))).toBe('http://localhost:4000');
    expect(publicBaseUrl(req({ host: '10.0.2.2:4000' }))).toBe('http://10.0.2.2:4000');
    expect(publicBaseUrl(req({ host: '192.168.1.20:4000' }))).toBe('http://192.168.1.20:4000');
  });

  it('uses the forwarded host and PUBLIC_API_URL when set', () => {
    expect(publicBaseUrl(req({ host: 'internal:10000', 'x-forwarded-host': 'api.edmira.org', 'x-forwarded-proto': 'https' }))).toBe('https://api.edmira.org');
    process.env.PUBLIC_API_URL = 'https://api.edmira.org/';
    expect(publicBaseUrl(req({ host: 'internal:10000' }))).toBe('https://api.edmira.org');
  });
});
