import { createHmac, timingSafeEqual } from 'crypto';

/**
 * ─── Paystack (web payments, edmira.org) ──────────────────────────────────────
 * Secret key: PAYSTACK_SECRET_KEY (sk_test_… / sk_live_…). Amounts are in kobo.
 * The web checkout page comes with the web app; the server side is ready.
 */

export interface PaystackTransaction {
  status: 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'reversed' | string;
  reference: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  metadata?: Record<string, unknown> | string | null;
}

export interface PaystackApi {
  readonly configured: boolean;
  initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl?: string; metadata: Record<string, unknown> }): Promise<{ authorizationUrl: string; accessCode: string }>;
  verify(reference: string): Promise<PaystackTransaction>;
  /** True if `signature` (x-paystack-signature) is the HMAC-SHA512 of the raw body. */
  validSignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYSTACK_API = Symbol('PAYSTACK_API');

const hmac512 = (secret: string, body: Buffer) => createHmac('sha512', secret).update(body).digest('hex');
const sameHex = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class LivePaystackApi implements PaystackApi {
  private readonly secret = process.env.PAYSTACK_SECRET_KEY?.trim() || '';

  get configured() {
    return !!this.secret;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    if (!this.secret) throw new Error('Paystack is not set up (PAYSTACK_SECRET_KEY).');
    const res = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || !json.status || !json.data) throw new Error(`Paystack: ${json.message ?? res.status}`);
    return json.data;
  }

  async initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl?: string; metadata: Record<string, unknown> }) {
    const data = await this.call<{ authorization_url: string; access_code: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountKobo,
      currency: 'NGN',
      reference: input.reference,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      metadata: input.metadata,
    });
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code };
  }

  verify(reference: string) {
    return this.call<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }

  validSignature(rawBody: Buffer, signature: string | undefined) {
    return !!this.secret && !!signature && sameHex(hmac512(this.secret, rawBody), signature);
  }
}

/** Tests: transactions registered with `put`, signatures with a known test secret. */
export class FakePaystackApi implements PaystackApi {
  readonly configured = true;
  static readonly SECRET = 'sk_test_fake';
  readonly transactions = new Map<string, PaystackTransaction>();

  async initialize(input: { reference: string }) {
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, accessCode: `ac_${input.reference}` };
  }
  async verify(reference: string) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error('Paystack: Transaction reference not found');
    return t;
  }
  validSignature(rawBody: Buffer, signature: string | undefined) {
    return !!signature && sameHex(hmac512(FakePaystackApi.SECRET, rawBody), signature);
  }
  static sign(body: string) {
    return hmac512(FakePaystackApi.SECRET, Buffer.from(body));
  }
}
