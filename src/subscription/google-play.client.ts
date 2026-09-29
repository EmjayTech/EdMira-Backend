import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import { DEFAULT_PACKAGE_NAME } from './pro.constants';

/** The fields of Google's SubscriptionPurchaseV2 that EdMira uses. */
export interface GoogleSubscription {
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: {
    productId: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string };
  }[];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * Talks to the Google Play Developer API with a service account, using a
 * signed JWT — no Google SDK needed.
 *
 * Setup: Play Console → Users & permissions → invite the service account with
 * "View financial data" + "Manage orders and subscriptions", then set
 * GOOGLE_PLAY_SERVICE_ACCOUNT_JSON to its key (raw JSON or base64).
 */
@Injectable()
export class GooglePlayClient {
  private readonly logger = new Logger(GooglePlayClient.name);
  private readonly packageName: string;
  private readonly account?: ServiceAccount;
  private token?: { value: string; expiresAt: number };

  constructor(config: ConfigService) {
    this.packageName = config.get('GOOGLE_PLAY_PACKAGE_NAME') || DEFAULT_PACKAGE_NAME;
    const raw = config.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    if (raw) {
      try {
        const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        this.account = JSON.parse(json);
      } catch {
        this.logger.error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON; Play purchases cannot be verified.');
      }
    }
  }

  get configured() {
    return !!this.account?.client_email && !!this.account?.private_key;
  }

  private async accessToken() {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Purchases can’t be verified right now. Your payment is safe — please try again later.',
      );
    }
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({ iss: this.account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.account.private_key);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${base64url(signature)}`,
      }),
    });
    if (!res.ok) {
      this.logger.error(`Google token request failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException('Purchases can’t be verified right now. Please try again later.');
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${API}/${this.packageName}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
    });
    return res;
  }

  /** The subscription behind a purchase token, or null if Google doesn't know it. */
  async getSubscription(purchaseToken: string): Promise<GoogleSubscription | null> {
    const res = await this.call(`purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
    if (res.status === 404 || res.status === 400 || res.status === 410) return null;
    if (!res.ok) {
      this.logger.error(`Google subscription lookup failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException('Purchases can’t be verified right now. Please try again later.');
    }
    return (await res.json()) as GoogleSubscription;
  }

  /**
   * Google refunds purchases that aren't acknowledged within 3 days, so the
   * server acknowledges as soon as it has recorded the purchase.
   */
  async acknowledge(productId: string, purchaseToken: string) {
    const res = await this.call(
      `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: 'POST', body: '{}' },
    );
    if (!res.ok) this.logger.warn(`Acknowledging ${productId} failed: ${res.status} ${await res.text()}`);
    return res.ok;
  }
}
