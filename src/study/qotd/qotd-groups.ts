import { Department } from '../../common/enum/department.enum';
import { Level } from '../../common/enum/level.enum';

/**
 * Question of the Day groups. Everyone in a group gets the same question:
 *   "ld:<level>|<department>"  e.g. "ld:100 Level|Physiology"
 *   "l:<level>"                when the level + department pool is too small
 *   "all"                      when the level pool is too small, or no level is set
 */
export const ALL_GROUP = 'all';

export interface QotdGroup {
  key: string;
  level?: string;
  department?: string;
}

/** Most specific first. */
export function candidateGroups(level?: string, department?: string): QotdGroup[] {
  const groups: QotdGroup[] = [];
  if (level && department) groups.push({ key: `ld:${level}|${department}`, level, department });
  if (level) groups.push({ key: `l:${level}`, level });
  groups.push({ key: ALL_GROUP });
  return groups;
}

/** A group key from an admin request, or null if it isn't a real level / department. */
export function parseGroup(key: string): QotdGroup | null {
  if (key === ALL_GROUP) return { key };
  const levels = Object.values(Level) as string[];
  const departments = Object.values(Department) as string[];
  if (key.startsWith('l:')) {
    const level = key.slice(2);
    return levels.includes(level) ? { key, level } : null;
  }
  if (key.startsWith('ld:')) {
    const [level, department] = key.slice(3).split('|');
    return levels.includes(level) && departments.includes(department) ? { key, level, department } : null;
  }
  return null;
}

type Rule = { level: string; department?: string; institution?: string };

/**
 * Whether a course's questions can be a group's QOTD. QOTD is shared across
 * schools, so school-only audience rules don't count. A course with no rules
 * is for everyone.
 */
export function courseFitsGroup(rules: Rule[] | undefined, group: QotdGroup): boolean {
  if (!rules?.length || !group.level) return true;
  return rules.some(
    r => !r.institution && r.level === group.level && (!group.department || !r.department || r.department === group.department),
  );
}

/** FNV-1a: a small, stable hash so the daily pick is the same on every server. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The day's pick: deterministic, skipping questions used in the last 30 days when possible. */
export function pickQuestion(pool: string[], recent: Set<string>, day: string, group: string): string | null {
  if (!pool.length) return null;
  const fresh = pool.filter(id => !recent.has(id));
  const candidates = fresh.length ? fresh : pool;
  return candidates[stableHash(`${day}|${group}`) % candidates.length];
}
