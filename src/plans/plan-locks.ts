/**
 * Pure helpers that hide Pro content from Free students while keeping it
 * visible as locked (so the app can show a 🔒 teaser, never a dead end).
 */

type Section = { heading: string };

/** Extended notes and the clinical correlation → just their headings, marked locked. */
export function lockNotes<T extends Record<string, unknown>>(topic: T): T {
  const extended = topic.extended as Section[] | undefined;
  const clinical = topic.clinical as Section[] | undefined;
  if (!extended?.length && !clinical?.length) return topic;
  const { extended: _e, clinical: _c, ...rest } = topic;
  return {
    ...rest,
    locked: {
      feature: 'extended_notes',
      extended: (extended ?? []).map(s => s.heading),
      clinical: (clinical ?? []).map(s => s.heading),
    },
  } as unknown as T;
}

/** Videos stay listed but without the link. */
export function lockVideo<T extends { kind?: string; link?: string; youTubeId?: string }>(r: T): T {
  if (r.kind !== 'video') return r;
  const { link: _l, youTubeId: _y, ...rest } = r;
  return { ...rest, locked: true, lockedFeature: 'videos' } as unknown as T;
}

/** Review without explanations (right / wrong and the correct option still show). */
export function lockExplanations<T extends { questions?: { explanation?: string }[] }>(review: T): T {
  return {
    ...review,
    explanationsLocked: true,
    questions: (review.questions ?? []).map(({ explanation: _x, ...q }) => q),
  } as T;
}
