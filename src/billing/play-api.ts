import { Logger } from '@nestjs/common';
import { createSign } from 'crypto';

/**
 * ─── Google Play Developer API (the parts billing needs) ─────────────────────
 *
 * Authenticates as a service account (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, the
 * JSON key, raw or base64) with a self-signed JWT, so no extra library.
 * Package name: GOOGLE_PLAY_PACKAGE_NAME (default com.emjaytech.edmira).
 */

/** subscriptionsv2 (the fields we use). */
export interface PlaySubscription {
  subscriptionState:
    | 'SUBSCRIPTION_STATE_PENDING'
    | 'SUBSCRIPTION_STATE_ACTIVE'
    | 'SUBSCRIPTION_STATE_PAUSED'
    | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
    | 'SUBSCRIPTION_STATE_ON_HOLD'
    | 'SUBSCRIPTION_STATE_CANCELED'
    | 'SUBSCRIPTION_STATE_EXPIRED'
    | 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'
    | string;
  acknowledgementState?: 'ACKNOWLEDGEMENT_STATE_PENDING' | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' | string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: {
    productId: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string };
  }[];
}

/** purchases.products (one-time products). purchaseState 0 purchased, 1 cancelled, 2 pending. */
export interface PlayProductPurchase {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  purchaseTimeMillis?: string;
  orderId?: string;
  obfuscatedExternalAccountId?: string;
  purchaseType?: number;
}

export interface PlayApi {
  readonly configured: boolean;
  getSubscription(token: string): Promise<PlaySubscription>;
  getProduct(productId: string, token: string): Promise<PlayProductPurchase>;
  acknowledgeSubscription(productId: string, token: string): Promise<void>;
  acknowledgeProduct(productId: string, token: string): Promise<void>;
}

export const PLAY_API = Symbol('PLAY_API');

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export class GooglePlayApi implements PlayApi {
  private readonly logger = new Logger('GooglePlayApi');
  private readonly pkg = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.emjaytech.edmira';
  private readonly key: { client_email: string; private_key: string } | null = readKey();
  private token?: { value: string; until: number };

  get configured() {
    return !!this.key;
  }

  private async accessToken(): Promise<string> {
    if (!this.key) throw new Error('Google Play billing is not set up (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).');
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.key.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.key.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Google auth failed: ${body.error ?? res.status}`);
    this.token = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    const res = await fetch(`${API}/${encodeURIComponent(this.pkg)}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`Play API ${method} ${path.split('/tokens/')[0]} → ${res.status}`);
      throw Object.assign(new Error(`Play API error ${res.status}`), { status: res.status });
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  getSubscription(token: string) {
    return this.call<PlaySubscription>('GET', `purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  }
  getProduct(productId: string, token: string) {
    return this.call<PlayProductPurchase>('GET', `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`);
  }
  async acknowledgeSubscription(productId: string, token: string) {
    await this.call('POST', `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
  async acknowledgeProduct(productId: string, token: string) {
    await this.call('POST', `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
}

function readKey(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const key = JSON.parse(json);
    return key.client_email && key.private_key ? { client_email: key.client_email, private_key: key.private_key } : null;
  } catch {
    return null;
  }
}

/**
 * Tests and the local dev server (PLAY_FAKE=1): purchases are whatever was
 * registered with `put`, so the whole flow runs without Google.
 */
export class FakePlayApi implements PlayApi {
  readonly configured = true;
  readonly subs = new Map<string, PlaySubscription>();
  readonly products = new Map<string, PlayProductPurchase>();
  readonly acknowledged: string[] = [];

  async getSubscription(token: string) {
    const s = this.subs.get(token);
    if (!s) throw Object.assign(new Error('Play API error 404'), { status: 404 });
    return s;
  }
  async getProduct(productId: string, token: string) {
    const p = this.products.get(`${productId}:${token}`);
    if (!p) throw Object.assign(new Error('Play API error 404'), { status: 404 });
    return p;
  }
  async acknowledgeSubscription(_productId: string, token: string) {
    this.acknowledged.push(token);
    const s = this.subs.get(token);
    if (s) s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  }
  async acknowledgeProduct(productId: string, token: string) {
    this.acknowledged.push(token);
    const p = this.products.get(`${productId}:${token}`);
    if (p) p.acknowledgementState = 1;
  }
}
