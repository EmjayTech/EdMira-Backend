/**
 * ─── Free vs Pro: what's locked, the limits and the plans ────────────────────
 *
 * Everything here is a DEFAULT. Admins change it in the dashboard (stored as
 * the "plans" app setting), so no code change is needed to move a feature
 * between Free and Pro, change a limit or a price.
 */

/** Features that can be locked behind Pro. Invites, QOTD, leaderboards, news, history and settings are always free. */
export const PRO_FEATURES = [
  /** Extended notes and the clinical correlation (Free keeps the standard notes and key points). */
  'extended_notes',
  /** Answer explanations in quiz review (Free still sees which answers were right). */
  'explanations',
  /** Notes PDFs and uploaded study materials (slides, textbooks) for offline use. */
  'downloads',
  /** Video lessons. */
  'videos',
  /** Starting a quiz challenge (accepting one stays free). */
  'create_challenge',
  /** Creating a study group (joining stays free). */
  'create_group',
  /** "Retry weak questions" and Focus areas "Fix it" practice. */
  'retry_weak',
  /** The per-topic breakdown on Progress (the app hides it; history stays free). */
  'detailed_progress',
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export type PlanKind = 'one_time' | 'subscription';

export interface PlanOffer {
  /** Stable id used by the apps and purchases: day | week | month | semester | year. */
  id: string;
  label: string;
  priceNaira: number;
  /** How long one purchase / billing period gives Pro. */
  days: number;
  kind: PlanKind;
  /** Google Play product id (one-time product for the day pass, subscription otherwise). */
  playProductId: string;
  /** Play base plan id for subscriptions. */
  playBasePlanId?: string;
  highlight?: 'popular' | 'best_value' | null;
  active: boolean;
}

export interface PlansConfig {
  /** Off until go-live: everyone has full access and no trials start. */
  enabled: boolean;
  /** Set when an admin switches plans on. Accounts created before this are Founding Testers. */
  goLiveAt: string | null;
  trialHours: number;
  foundingDays: number;
  freeDailyMcqs: number;
  proDailyMcqs: number;
  locks: Record<ProFeature, 'free' | 'pro'>;
  catalog: PlanOffer[];
}

export const DEFAULT_PLANS: PlansConfig = {
  enabled: false,
  goLiveAt: null,
  trialHours: 72,
  foundingDays: 30,
  freeDailyMcqs: 30,
  proDailyMcqs: 100,
  locks: {
    extended_notes: 'pro',
    explanations: 'pro',
    downloads: 'pro',
    videos: 'pro',
    create_challenge: 'pro',
    create_group: 'pro',
    retry_weak: 'pro',
    detailed_progress: 'pro',
  },
  catalog: [
    { id: 'day', label: 'Day pass', priceNaira: 1000, days: 1, kind: 'one_time', playProductId: 'edmira_pro_day', highlight: null, active: true },
    { id: 'week', label: 'Weekly', priceNaira: 5000, days: 7, kind: 'subscription', playProductId: 'edmira_pro', playBasePlanId: 'weekly', highlight: null, active: true },
    { id: 'month', label: 'Monthly', priceNaira: 15000, days: 30, kind: 'subscription', playProductId: 'edmira_pro', playBasePlanId: 'monthly', highlight: 'popular', active: true },
    { id: 'semester', label: 'Semester', priceNaira: 40000, days: 182, kind: 'subscription', playProductId: 'edmira_pro', playBasePlanId: 'six-months', highlight: null, active: true },
    { id: 'year', label: 'Yearly', priceNaira: 70000, days: 365, kind: 'subscription', playProductId: 'edmira_pro', playBasePlanId: 'yearly', highlight: 'best_value', active: true },
  ],
};

/** Allowed ranges for the numbers admins can edit. */
export const PLAN_LIMITS = {
  trialHours: [0, 24 * 30],
  foundingDays: [0, 365],
  freeDailyMcqs: [0, 1000],
  proDailyMcqs: [1, 5000],
} as const;

/**
 * Savings shown on each plan versus buying a shorter plan repeatedly: weekly
 * vs 7 day passes, monthly vs 4 weeks, and longer plans vs the monthly plan
 * (semester vs 6 months, yearly vs 12 months). Null if it saves nothing.
 */
export function withSavings(catalog: PlanOffer[]) {
  const live = catalog.filter(p => p.active).sort((a, b) => a.days - b.days);
  const monthly = live.filter(p => p.days >= 28 && p.days <= 31)[0];
  return live.map((p, i) => {
    const shorter = p.days >= 60 && monthly ? monthly : live[i - 1];
    if (!shorter) return { ...p, savesPercent: null, comparedWith: null };
    const units = Math.max(1, Math.round(p.days / shorter.days));
    const full = units * shorter.priceNaira;
    const saves = full > p.priceNaira ? Math.round(((full - p.priceNaira) / full) * 100) : 0;
    return { ...p, savesPercent: saves > 0 ? saves : null, comparedWith: saves > 0 ? { plan: shorter.id, units, priceNaira: full } : null };
  });
}
