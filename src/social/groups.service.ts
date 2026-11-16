import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { ContentService } from '../content/content.service';
import { LeaderboardWeek, LeaderboardWeekDocument } from '../leaderboard/leaderboard-week.schema';
import { weekOf } from '../leaderboard/week';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { User, UserDocument } from '../users/model/user.model';
import { isOffensiveUsername } from '../users/username-policy';
import { NotificationsService } from './notifications.service';
import { Person, PeopleService, publicStudent } from './people.service';
import { StudyGroup, StudyGroupDocument } from './schemas/study-group.schema';
import { GROUPS } from './social-policy';

const NOT_FOUND = { statusCode: 404, message: 'Not found' };
const newCode = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(8)].map(b => alphabet[b % alphabet.length]).join('');
};
const same = (a: unknown, b: unknown) => String(a) === String(b);

/**
 * Study groups: invite accepted connections only, everyone joins by saying
 * yes (an invite, or tapping Join on a group code), ≤ 30 members, and two
 * students who blocked each other never meet inside a group. Every route is
 * authorised here — you only see and touch groups you belong to.
 */
@Injectable()
export class GroupsService {
  constructor(
    @InjectModel(StudyGroup.name) private readonly groups: Model<StudyGroupDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly people: PeopleService,
    private readonly content: ContentService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Creating & listing ─────────────────────────────────────────────────────

  async create(userId: string, name: string, courseId?: string) {
    const me = await this.people.me(userId);
    if (me.role || !this.people.isActive(me)) throw new ForbiddenException();
    const clean = this.checkName(name);
    const owned = await this.groups.countDocuments({ ownerId: me._id });
    if (owned >= GROUPS.maxOwned) {
      throw new HttpException(
        { statusCode: 429, code: 'GROUP_LIMIT', message: `You can own up to ${GROUPS.maxOwned} groups.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let courseTitle: string | undefined;
    if (courseId) courseTitle = (await this.content.getCourse(courseId)).title;
    const group = await this.groups.create({
      name: clean,
      courseId: courseId ? new Types.ObjectId(courseId) : undefined,
      courseTitle,
      ownerId: me._id,
      code: newCode(),
      members: [{ userId: me._id, role: 'owner', joinedAt: new Date() }],
    });
    return this.detail(userId, String(group._id));
  }

  /** My groups and the invitations waiting for me. */
  async mine(userId: string) {
    const id = new Types.ObjectId(userId);
    const [member, invited] = await Promise.all([
      this.groups.find({ 'members.userId': id }).sort({ updatedAt: -1 }).lean().exec(),
      this.groups.find({ 'invites.userId': id }).sort({ updatedAt: -1 }).lean().exec(),
    ]);
    const inviters = await this.users
      .find({ _id: { $in: invited.map(g => g.invites.find(i => same(i.userId, id))!.invitedBy) } })
      .select('username')
      .lean()
      .exec();
    const names = new Map(inviters.map(u => [String(u._id), u.username]));
    return {
      groups: member.map(g => ({
        id: String(g._id),
        name: g.name,
        courseTitle: g.courseTitle ?? null,
        memberCount: g.members.length,
        role: g.members.find(m => same(m.userId, id))!.role,
      })),
      invitations: invited.map(g => ({
        id: String(g._id),
        name: g.name,
        courseTitle: g.courseTitle ?? null,
        memberCount: g.members.length,
        invitedBy: names.get(String(g.invites.find(i => same(i.userId, id))!.invitedBy)) ?? null,
      })),
    };
  }

  // ── One group ──────────────────────────────────────────────────────────────

  /** The group as a member sees it: members, this week's mini leaderboard, recent activity. */
  async detail(userId: string, groupId: string) {
    const g = await this.memberOf(userId, groupId);
    const hidden = await this.people.blockedEitherWay(userId); // blocked pairs are hidden from each other
    const visible = g.members.filter(m => same(m.userId, userId) || !hidden.has(String(m.userId)));
    const ids = visible.map(m => m.userId);
    const [people, points, recent] = await Promise.all([
      this.users.find({ _id: { $in: ids } }).select('username role studentProfile').lean<Person[]>().exec(),
      this.weeks.find({ week: weekOf(new Date()), studentId: { $in: ids } }).select('studentId points').lean().exec(),
      this.attempts
        .find({ studentId: { $in: ids }, submittedAt: { $gte: new Date(Date.now() - GROUPS.activityDays * 86_400_000) } })
        .select('studentId topicTitle courseTitle submittedAt')
        .sort({ submittedAt: -1 })
        .limit(20)
        .lean()
        .exec(),
    ]);
    const byId = new Map(people.map(p => [String(p._id), p]));
    const pts = new Map(points.map(p => [String(p.studentId), p.points]));
    const role = g.members.find(m => same(m.userId, userId))!.role;
    const rows = visible.flatMap(m => {
      const p = byId.get(String(m.userId));
      return p ? [{ id: String(m.userId), member: { ...publicStudent(p), role: m.role, isMe: same(m.userId, userId), joinedAt: m.joinedAt.toISOString() } }] : [];
    });
    const members = rows.map(r => r.member);
    return {
      id: String(g._id),
      name: g.name,
      courseTitle: g.courseTitle ?? null,
      role,
      memberCount: g.members.length,
      maxMembers: GROUPS.maxMembers,
      // Only the owner sees (and shares) the join code.
      code: role === 'owner' ? g.code : null,
      codeEnabled: g.codeEnabled,
      members,
      // This week's points (from the weekly leaderboard).
      leaderboard: rows
        .map(r => ({ username: r.member.username, points: pts.get(r.id) ?? 0, isMe: r.member.isMe }))
        .sort((a, b) => b.points - a.points)
        .map((m, i) => ({ rank: i + 1, ...m })),
      // Topics practised — never scores.
      activity: recent.flatMap(a => {
        const p = byId.get(String(a.studentId));
        return p ? [{ username: p.username, topicTitle: a.topicTitle, courseTitle: a.courseTitle, at: a.submittedAt.toISOString() }] : [];
      }),
    };
  }

  // ── Invites ────────────────────────────────────────────────────────────────

  /** Invite one of YOUR accepted connections. They must accept to join. */
  async invite(userId: string, groupId: string, username: string) {
    const g = await this.memberOf(userId, groupId);
    const me = await this.people.me(userId);
    const target = await this.people.visible(me, username);
    if (!target || target.role || !(await this.people.areConnected(me._id, target._id))) throw new NotFoundException(NOT_FOUND);
    if (g.members.some(m => same(m.userId, target._id)) || g.invites.some(i => same(i.userId, target._id))) return { ok: true };
    if (g.members.length + g.invites.length >= GROUPS.maxMembers) {
      throw new ConflictException({ statusCode: 409, code: 'GROUP_FULL', message: `A group can have up to ${GROUPS.maxMembers} members.` });
    }
    const today = await this.groups.countDocuments({
      invites: { $elemMatch: { invitedBy: me._id, createdAt: { $gte: new Date(Date.now() - 86_400_000) } } },
    });
    if (today >= GROUPS.invitesPerDay) {
      throw new HttpException(
        { statusCode: 429, code: 'GROUP_INVITE_LIMIT', message: `You can send ${GROUPS.invitesPerDay} group invites a day.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    g.invites.push({ userId: target._id, invitedBy: me._id, createdAt: new Date() });
    await g.save();
    await this.notifications.notify(target._id, 'group_invite', me._id, String(g._id));
    return { ok: true };
  }

  async answerInvite(userId: string, groupId: string, accept: boolean) {
    const g = await this.groups.findOne({ _id: groupId, 'invites.userId': new Types.ObjectId(userId) }).exec();
    if (!g) throw new NotFoundException(NOT_FOUND);
    g.invites = g.invites.filter(i => !same(i.userId, userId));
    if (accept) await this.addMember(g, userId);
    await g.save();
    return accept ? this.detail(userId, groupId) : { ok: true };
  }

  // ── Join codes ─────────────────────────────────────────────────────────────

  /** What a code leads to (before joining). 404 if the code is off or unknown. */
  async preview(userId: string, code: string) {
    const g = await this.byCode(code);
    return {
      id: String(g._id),
      name: g.name,
      courseTitle: g.courseTitle ?? null,
      memberCount: g.members.length,
      isMember: g.members.some(m => same(m.userId, userId)),
    };
  }

  /** Tapping Join is the student's consent. */
  async joinByCode(userId: string, code: string) {
    const g = await this.byCode(code);
    if (!g.members.some(m => same(m.userId, userId))) {
      g.invites = g.invites.filter(i => !same(i.userId, userId));
      await this.addMember(g, userId);
      await g.save();
    }
    return this.detail(userId, String(g._id));
  }

  /** Owner: turn the code on or off, or replace it (the old one stops working). */
  async setCode(userId: string, groupId: string, input: { enabled?: boolean; reset?: boolean }) {
    const g = await this.ownerOf(userId, groupId);
    if (input.enabled !== undefined) g.codeEnabled = input.enabled;
    if (input.reset) g.code = newCode();
    await g.save();
    return this.detail(userId, groupId);
  }

  // ── Leaving & removing ─────────────────────────────────────────────────────

  async removeMember(userId: string, groupId: string, username: string) {
    const g = await this.ownerOf(userId, groupId);
    const target = await this.people.byUsername(username);
    if (!target || same(target._id, userId) || !g.members.some(m => same(m.userId, target._id))) throw new NotFoundException(NOT_FOUND);
    g.members = g.members.filter(m => !same(m.userId, target._id));
    await g.save();
    return this.detail(userId, groupId);
  }

  /** Leave. An owner hands the group to the longest-standing member; an empty group is deleted. */
  async leave(userId: string, groupId: string) {
    const g = await this.memberOf(userId, groupId);
    const wasOwner = same(g.ownerId, userId);
    g.members = g.members.filter(m => !same(m.userId, userId));
    if (!g.members.length) {
      await g.deleteOne();
      return { ok: true, deleted: true };
    }
    if (wasOwner) {
      const next = [...g.members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
      next.role = 'owner';
      g.ownerId = next.userId;
    }
    await g.save();
    return { ok: true, deleted: false };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private checkName(name: string) {
    const clean = (name ?? '').trim().replace(/\s+/g, ' ');
    if (clean.length < GROUPS.nameMin || clean.length > GROUPS.nameMax) {
      throw new BadRequestException({ statusCode: 400, code: 'GROUP_NAME_INVALID', message: `Group names are ${GROUPS.nameMin}–${GROUPS.nameMax} characters.` });
    }
    const words = clean.toLowerCase().split(/[^a-z0-9@$!]+/).filter(Boolean);
    if (isOffensiveUsername(clean.toLowerCase().replace(/[^a-z0-9._@$!]/g, '')) || words.some(w => isOffensiveUsername(w))) {
      throw new BadRequestException({ statusCode: 400, code: 'GROUP_NAME_OFFENSIVE', message: "That group name isn't allowed." });
    }
    return clean;
  }

  /** Joining needs: active student, room left, and no block with anyone already inside. */
  private async addMember(g: StudyGroupDocument, userId: string) {
    const me = await this.people.me(userId);
    if (me.role || !this.people.isActive(me)) throw new NotFoundException(NOT_FOUND);
    if (g.members.length >= GROUPS.maxMembers) {
      throw new ConflictException({ statusCode: 409, code: 'GROUP_FULL', message: `A group can have up to ${GROUPS.maxMembers} members.` });
    }
    const hidden = await this.people.blockedEitherWay(userId);
    if (g.members.some(m => hidden.has(String(m.userId)))) throw new NotFoundException(NOT_FOUND);
    g.members.push({ userId: me._id, role: 'member', joinedAt: new Date() });
  }

  private async memberOf(userId: string, groupId: string) {
    const g = await this.groups.findOne({ _id: groupId, 'members.userId': new Types.ObjectId(userId) }).exec();
    if (!g) throw new NotFoundException(NOT_FOUND);
    return g;
  }

  private async ownerOf(userId: string, groupId: string) {
    const g = await this.memberOf(userId, groupId);
    if (!same(g.ownerId, userId)) throw new ForbiddenException({ statusCode: 403, code: 'OWNER_ONLY', message: 'Only the group owner can do that.' });
    return g;
  }

  private async byCode(code: string) {
    const g = /^[a-z0-9]{6,12}$/i.test(code ?? '') ? await this.groups.findOne({ code: code.toLowerCase(), codeEnabled: true }).exec() : null;
    if (!g) throw new NotFoundException(NOT_FOUND);
    return g;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async adminList(q?: string) {
    const filter = q ? { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
    const rows = await this.groups.find(filter).sort({ createdAt: -1 }).limit(200).lean().exec();
    const owners = await this.users.find({ _id: { $in: rows.map(r => r.ownerId) } }).select('username').lean().exec();
    const names = new Map(owners.map(o => [String(o._id), o.username]));
    return rows.map(r => ({
      id: String(r._id),
      name: r.name,
      courseTitle: r.courseTitle ?? null,
      owner: names.get(String(r.ownerId)) ?? '',
      memberCount: r.members.length,
      pendingInvites: r.invites.length,
      codeEnabled: r.codeEnabled,
      createdAt: r.createdAt?.toISOString() ?? null,
    }));
  }

  async adminDetail(groupId: string) {
    const g = await this.groups.findById(groupId).lean().exec();
    if (!g) throw new NotFoundException('That group no longer exists.');
    const users = await this.users.find({ _id: { $in: g.members.map(m => m.userId) } }).select('username firstName lastName email').lean().exec();
    const byId = new Map(users.map(u => [String(u._id), u]));
    return {
      id: String(g._id),
      name: g.name,
      courseTitle: g.courseTitle ?? null,
      members: g.members.map(m => {
        const u = byId.get(String(m.userId));
        return {
          id: String(m.userId),
          username: u?.username ?? '',
          name: [u?.firstName, u?.lastName].filter(Boolean).join(' '),
          email: u?.email ?? '',
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        };
      }),
    };
  }

  async adminDelete(groupId: string) {
    const g = await this.groups.findByIdAndDelete(groupId).exec();
    if (!g) throw new NotFoundException('That group no longer exists.');
    return { name: g.name, memberCount: g.members.length, ownerId: String(g.ownerId) };
  }
}
