# EdMira Pro payments: setup and how it works

The server is the only judge of who has Pro. The apps only display it.

- **Android:** Google Play Billing. The app sends each purchase token to the server. The server checks it with Google, grants Pro, then acknowledges it.
- **Web:** Paystack. The server side is ready; the checkout page comes with the web app.

Plans, prices and feature locks are edited in the admin dashboard (the `plans` setting). In Google Play Console, the product ids and prices must match that setting.

## 1. Google Play Console

1. **Monetize → Products → In-app products**: create `edmira_pro_day`, a one-time product at ₦1,000.
   - The app consumes each purchase, so it can be bought again.
2. **Monetize → Products → Subscriptions**: create `edmira_pro` with these base plans, all auto-renewing:

   | Base plan id | Billing period | Price   |
   |--------------|----------------|---------|
   | `weekly`     | 1 week         | ₦5,000  |
   | `monthly`    | 1 month        | ₦15,000 |
   | `six-months` | 6 months       | ₦40,000 |
   | `yearly`     | 1 year         | ₦70,000 |

   - Play's naira range is ₦25–₦610,000, so these prices work as they are.
   - If you change a price in Play, change it in Admin → Plans too.
   - On Android, the app shows Play's own price when it can reach Play.
3. **Service account** (the server uses it to verify purchases):
   1. In Google Cloud, create a service account and download its JSON key.
   2. In Play Console → Users and permissions, invite the service account's email to the app.
   3. Give it **View financial data** and **Manage orders and subscriptions**.
   4. Put the key in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. Raw JSON or base64 both work. Never commit it.
4. **Real-time developer notifications** (renewals, cancellations, refunds):
   1. In Google Cloud Pub/Sub, create a topic. Give `google-play-developer-notifications@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
   2. Create a **push** subscription to `https://<api-host>/api/v1/billing/play/notifications?token=<PLAY_RTDN_TOKEN>`. Use a long random `PLAY_RTDN_TOKEN` and set the same value on the server.
   3. In Play Console → Monetization setup, enter the topic name and press **Send test notification**.
5. **Testing:**
   1. Add tester Gmail accounts under Settings → License testing. They pay with test cards and are never charged.
   2. Upload a build to the **internal testing** track and install it from the testers link, signed in to Play with a tester account.
6. **Data safety form** (Play Console → App content): under **Financial info → Purchase history**, declare it as collected, not shared, and used for app functionality. Google handles card details; EdMira never sees them.

## 2. Paystack (web)

- Set `PAYSTACK_SECRET_KEY` (`sk_test_…` while testing) and `PAYSTACK_CALLBACK_URL` (the web "thank you" page).
- In the Paystack dashboard → Settings → API Keys & Webhooks, set the webhook URL to `https://<api-host>/api/v1/billing/paystack/webhook`.
- The server checks the `x-paystack-signature` header, then re-checks every payment with Paystack's API (amount and currency in NGN) before granting Pro.
- Web payments are one period at a time for now. Automatic renewal on the web (Paystack plans) will come with the web checkout.

## 3. How a purchase becomes Pro

**Android**
1. The app asks Play to buy, sending `obfuscatedAccountId`, a non-reversible id for the account.
2. Play returns a purchase token to the app.
3. The app sends it to `POST /me/plan/play/verify`.
4. The server reads the purchase from Google and checks that it belongs to this account.
5. The server records Pro until the end of the period, then acknowledges the purchase.
6. The app then finishes the transaction: it consumes a day pass, and acknowledges a subscription.

**Edge cases**
- **Unfinished purchases** (the app was killed or went offline) are retried on the next app open, well inside Google's 3-day acknowledgement window.
- **Restore purchases** sends everything Play holds for this phone to `POST /me/plan/play/restore`.
- **A purchase token can only ever belong to one account.**

**Renewals, cancellations, holds and refunds** arrive as Play notifications:

| What happens                            | Result                                |
|-----------------------------------------|---------------------------------------|
| Renewal or grace period                 | Pro continues                         |
| Cancelled (auto-renew off)              | Pro continues until the period ends   |
| On hold, paused or expired              | Back to Free                          |
| Refunded or voided                      | Pro is taken back                     |

**Paystack**
1. `POST /me/plan/paystack/initialize` returns the checkout URL.
2. Paystack calls the webhook (or the page calls `GET /me/plan/paystack/verify/:reference`).
3. The server verifies the payment with Paystack and grants Pro exactly once.

**Pro from several sources:** Pro runs until the latest end date among all active purchases, admin grants and the Founding Tester month. A day pass or Paystack period bought while Pro is running is added on after the current end.

## 4. Local testing without the stores

- `PLAY_FAKE=1` / `PAYSTACK_FAKE=1` use stand-ins, so the whole server flow runs without Google or Paystack. The e2e tests always use them.
- Never set these in production.
