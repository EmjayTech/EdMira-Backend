import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import sharp from 'sharp';
import { lagosDay } from '../leaderboard/week';
import { FileStorageService } from '../storage/file-storage.service';
import { User, UserDocument } from '../users/model/user.model';
import { AVATAR_CHANGES_PER_DAY, AVATAR_MAX_UPLOAD_BYTES, AVATAR_PRESETS, AVATAR_SIZE } from './avatar-view';

/** Formats we accept, judged by the file's content, never its name. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

/**
 * Profile pictures: a built-in avatar or an uploaded photo. Photos are
 * re-encoded here (512×512 WebP, no EXIF / location data) whatever the
 * client already did, and stored under a new name on every change.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly storage: FileStorageService,
  ) {}

  async setPreset(userId: string, preset: string) {
    if (!AVATAR_PRESETS.includes(preset)) throw new BadRequestException({ code: 'AVATAR_PRESET_UNKNOWN', message: 'Pick one of the avatars shown.' });
    return this.apply(userId, { kind: 'preset', preset, at: new Date() });
  }

  async uploadPhoto(userId: string, file?: { buffer: Buffer; size: number }) {
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'AVATAR_FILE_MISSING', message: 'Choose a photo to upload.' });
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) throw new BadRequestException({ code: 'AVATAR_TOO_LARGE', message: 'That photo is too large (5 MB max).' });
    await this.assertQuota(userId); // before the costly re-encode
    const image = await this.reencode(file.buffer);
    const key = `avatars/${randomUUID()}.webp`;
    await this.storage.savePublic(key, image, 'image/webp');
    try {
      return await this.apply(userId, { kind: 'photo', key, at: new Date() });
    } catch (err) {
      await this.storage.deletePublic(key);
      throw err;
    }
  }

  /** Back to initials. Doesn't count towards the daily limit. */
  async remove(userId: string) {
    const before = await this.users.findById(userId).select('avatar').lean().exec();
    if (!before) throw new NotFoundException();
    const user = await this.users.findByIdAndUpdate(userId, { $unset: { avatar: 1 } }, { new: true }).exec();
    await this.storage.deletePublic(before.avatar?.key);
    return user!;
  }

  /** Admin moderation: drop the photo (not a preset) and revert to initials. */
  async removeForModeration(userId: string): Promise<boolean> {
    const before = await this.users.findById(userId).select('avatar').lean().exec();
    if (before?.avatar?.kind !== 'photo') return false;
    await this.users.updateOne({ _id: userId, 'avatar.key': before.avatar.key }, { $unset: { avatar: 1 } }).exec();
    await this.storage.deletePublic(before.avatar.key);
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async reencode(input: Buffer): Promise<Buffer> {
    let format: string | undefined;
    try {
      format = (await sharp(input, { failOn: 'error' }).metadata()).format;
    } catch {
      format = undefined;
    }
    if (!format || !ACCEPTED_FORMATS.has(format)) {
      throw new BadRequestException({ code: 'AVATAR_NOT_IMAGE', message: 'That file isn’t a photo we can use. Try a JPEG or PNG.' });
    }
    try {
      return await sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
        .rotate() // apply the camera's orientation, then the EXIF goes
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
        .flatten({ background: '#ffffff' })
        .webp({ quality: 80 })
        .toBuffer(); // sharp drops all metadata (EXIF, GPS, ICC) unless asked to keep it
    } catch (err) {
      this.logger.warn(`Avatar re-encode failed: ${(err as Error).message}`);
      throw new BadRequestException({ code: 'AVATAR_NOT_IMAGE', message: 'We couldn’t read that photo. Try another one.' });
    }
  }

  private async assertQuota(userId: string) {
    const user = await this.users.findById(userId).select('avatarQuota').lean().exec();
    if (!user) throw new NotFoundException();
    const today = lagosDay(new Date());
    if (user.avatarQuota?.day === today && user.avatarQuota.count >= AVATAR_CHANGES_PER_DAY) this.tooMany();
  }

  private tooMany(): never {
    throw new HttpException(
      { code: 'AVATAR_LIMIT', message: `You can change your picture ${AVATAR_CHANGES_PER_DAY} times a day. Try again tomorrow.` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Saves the new avatar and counts it, atomically against the daily cap. */
  private async apply(userId: string, avatar: NonNullable<User['avatar']>) {
    const today = lagosDay(new Date());
    const before = await this.users.findById(userId).select('avatar').lean().exec();
    if (!before) throw new NotFoundException();
    const updated =
      (await this.users
        .findOneAndUpdate(
          { _id: userId, 'avatarQuota.day': today, 'avatarQuota.count': { $lt: AVATAR_CHANGES_PER_DAY } },
          { $set: { avatar }, $inc: { 'avatarQuota.count': 1 } },
          { new: true },
        )
        .exec()) ??
      (await this.users
        .findOneAndUpdate(
          { _id: userId, 'avatarQuota.day': { $ne: today } },
          { $set: { avatar, avatarQuota: { day: today, count: 1 } } },
          { new: true },
        )
        .exec());
    if (!updated) this.tooMany();
    if (before.avatar?.key && before.avatar.key !== avatar.key) await this.storage.deletePublic(before.avatar.key);
    return updated;
  }
}
