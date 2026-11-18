/**
 * Emails about the student's plan (trial and Founding Tester). Same messages
 * as the in-app modals. Times are Lagos time.
 */

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const lagosDateTime = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
export const lagosDate = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' }).format(d);

const FREE_LIST = ['Up to 30 practice questions a day', 'Standard notes and key points', 'Question of the Day, streaks and leaderboards', 'Inviting classmates (and earning points for it)'];
const PRO_LIST = ['Up to 100 practice questions a day', 'Extended notes and clinical correlation', 'Full answer explanations', 'Quiz challenges, study groups and "Fix it" practice', 'Notes PDFs, downloads and videos'];

const list = (items: string[]) => `<ul style="padding-left:20px;margin:8px 0;">${items.map(i => `<li style="margin:4px 0;">${esc(i)}</li>`).join('')}</ul>`;

const layout = (title: string, body: string) => `
  <html>
    <body style="font-family: Arial, sans-serif; background:#f6f8fa;">
      <div style="max-width:600px;margin:auto;background:#fff;padding:20px;border-radius:8px;">
        <h1 style="background:#0a369d;color:#fff;padding:15px;text-align:center;font-size:22px;">${title}</h1>
        ${body}
        <p style="margin-top:20px;">Open the EdMira app to keep studying. Your plan is always under <strong>Profile → My plan</strong>.</p>
        <hr />
        <small>&copy; ${new Date().getFullYear()} EdMira</small>
      </div>
    </body>
  </html>`;

export function planEmail(key: string, d: { firstName: string; trialEndsAt?: Date; proExpiresAt?: Date }): { subject: string; html: string } | null {
  const hi = `<p>Hi ${esc(d.firstName || 'there')},</p>`;
  switch (key) {
    case 'trial_welcome':
      return {
        subject: '🎉 Welcome to EdMira: 3 days of Pro, free',
        html: layout(
          'Welcome to EdMira',
          `${hi}<p>You have <strong>3 days of full Pro access</strong>, free. Explore everything: more questions, full notes, explanations, challenges and more.</p>
           ${d.trialEndsAt ? `<p>Your Pro trial ends on <strong>${lagosDateTime(d.trialEndsAt)}</strong> (Lagos time).</p>` : ''}
           <p>After that, some features are locked unless you upgrade to Pro. EdMira Free still includes:</p>${list(FREE_LIST)}`,
        ),
      };
    case 'trial_24h':
      return {
        subject: '⏳ Your EdMira Pro trial ends tomorrow',
        html: layout(
          'Your Pro trial ends tomorrow',
          `${hi}<p>Your Pro trial ends ${d.trialEndsAt ? `on <strong>${lagosDateTime(d.trialEndsAt)}</strong>` : 'tomorrow'}.</p>
           <p>After that, these are part of Pro:</p>${list(PRO_LIST)}<p>Upgrade in the app to keep them.</p>`,
        ),
      };
    case 'trial_ended':
      return {
        subject: 'Your EdMira Pro trial has ended',
        html: layout(
          "You're now on EdMira Free",
          `${hi}<p>Your 3-day Pro trial has ended. You're now on <strong>EdMira Free</strong>, which still includes:</p>${list(FREE_LIST)}
           <p>Upgrade to Pro any time in the app for:</p>${list(PRO_LIST)}`,
        ),
      };
    case 'founding_welcome':
      return {
        subject: '🏅 Thank you, Founding Tester: 1 month of EdMira Pro, free',
        html: layout(
          'Thank you, Founding Tester!',
          `${hi}<p>Thank you for helping us build EdMira. You have <strong>1 month of EdMira Pro free</strong>${d.proExpiresAt ? `, until <strong>${lagosDate(d.proExpiresAt)}</strong>` : ''}.</p>
           <p>That includes:</p>${list(PRO_LIST)}`,
        ),
      };
    case 'founding_3d':
    case 'founding_1d':
      return {
        subject: key === 'founding_1d' ? 'Your free Pro month ends tomorrow' : 'Your free Pro month ends in 3 days',
        html: layout(
          'Your Founding Tester month is ending',
          `${hi}<p>Your free month of EdMira Pro ends ${d.proExpiresAt ? `on <strong>${lagosDateTime(d.proExpiresAt)}</strong>` : 'soon'}.</p>
           <p>After that you'll be on EdMira Free. Upgrade in the app to keep:</p>${list(PRO_LIST)}`,
        ),
      };
    default:
      return null;
  }
}
