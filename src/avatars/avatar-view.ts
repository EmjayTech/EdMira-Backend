import type { User } from '../users/model/user.model';

/** Built-in avatars the app draws itself (a01 … a18). */
export const AVATAR_PRESETS = Array.from({ length: 18 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);

/** Uploaded photos are re-encoded to this size and format. */
export const AVATAR_SIZE = 512;
export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const AVATAR_CHANGES_PER_DAY = 10;

export const avatarUrlForKey = (key: string) => {
  const base = process.env.STORAGE_PUBLIC_URL;
  return base ? `${base.replace(/\/+$/, '')}/${key}` : `/api/v1/files/${key}`;
};

export type AvatarView = { preset: string | null; url: string | null };

/**
 * What clients get: a preset id, or a photo URL (absolute with a CDN,
 * otherwise relative to the API host), or neither → show initials.
 */
export const avatarView = (u: Pick<User, 'avatar'> | null | undefined): AvatarView => {
  const a = u?.avatar;
  if (a?.kind === 'photo' && a.key) return { preset: null, url: avatarUrlForKey(a.key) };
  if (a?.kind === 'preset' && a.preset && AVATAR_PRESETS.includes(a.preset)) return { preset: a.preset, url: null };
  return { preset: null, url: null };
};
