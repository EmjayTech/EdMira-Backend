import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { DateRangeQuery } from './dto/admin.dto';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { Model } from 'mongoose';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import type { PlansConfig } from '../plans/plan-config';
import { PlansService } from '../plans/plans.service';
import { User, UserDocument } from '../users/model/user.model';
import { AuditService } from './audit/audit.service';
import { CurrentStaff, RequirePermission, Staff, StaffGuard } from './staff.guard';

class GrantProDto {
  @ApiProperty({ example: '2027-01-31T23:59:00+01:00' }) @IsISO8601() until: string;
  @ApiProperty({ required: false, example: 'Campus ambassador' }) @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class RevokeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) note?: string;
}

/** Admin → Plans: Free/Pro settings, Founding Testers, granting Pro. */
@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('admin')
export class AdminPlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly auditLog: AuditService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  @Get('plans')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Plan settings: on/off, trial length, daily limits, feature locks, prices' })
  config() {
    return this.plans.config();
  }

  @Put('plans')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Change plan settings (validated). Switching on the first time sets go-live (Founding Tester cut-off).' })
  async update(@CurrentStaff() staff: Staff, @Body() body: Partial<PlansConfig>) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Send the settings to change.');
    const before = await this.plans.config();
    const after = await this.plans.updateConfig(body, staff.name);
    const changed = Object.keys(body).filter(k => JSON.stringify((before as never)[k]) !== JSON.stringify((after as never)[k]));
    const summary = before.enabled !== after.enabled ? `${after.enabled ? 'Switched on' : 'Switched off'} Free/Pro plans` : `Changed plan settings: ${changed.join(', ') || 'nothing'}`;
    await this.auditLog.log(staff, 'plans', 'plans', 'updated', summary);
    return after;
  }

  @Get('plans/stats')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Students per plan, active subscriptions, purchases and revenue, trial → Pro conversion (from/to: ISO dates, default last 30 days)' })
  stats(@Query() query: DateRangeQuery) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (!(from < to)) throw new BadRequestException('"from" must be before "to".');
    return this.plans.stats(from, to);
  }

  @Get('plans/founding-testers')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Dry run: who gets the Founding Tester month (accounts created before go-live, or before now if not live yet)' })
  async foundingPreview() {
    const cfg = await this.plans.config();
    return this.plans.foundingTesters(false, cfg.goLiveAt ? new Date(cfg.goLiveAt) : new Date());
  }

  @Post('plans/founding-testers/apply')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Give every Founding Tester their month of Pro now (plans must be on). Emails go out from the hourly job.' })
  async foundingApply(@CurrentStaff() staff: Staff) {
    const cfg = await this.plans.config();
    if (!cfg.enabled || !cfg.goLiveAt) throw new BadRequestException('Switch plans on first: go-live is the Founding Tester cut-off.');
    const result = await this.plans.foundingTesters(true, new Date(cfg.goLiveAt));
    await this.auditLog.log(staff, 'plans', 'founding_testers', 'granted', `Gave ${result.count} Founding Testers Pro until ${result.until.slice(0, 10)}`);
    return { count: result.count, until: result.until };
  }

  @Get('students/:id/plan')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: "A student's plan, today's questions and their Pro grants / purchases" })
  async studentPlan(@Param('id', ParseObjectIdPipe) id: string) {
    const [summary, entitlements] = await Promise.all([this.plans.summary(id), this.plans.entitlementsOf(id)]);
    const { plans: _plans, notice: _notice, ...plan } = summary;
    return {
      plan,
      entitlements: entitlements.map(e => ({
        id: String(e._id),
        source: e.source,
        planId: e.planId ?? null,
        startsAt: e.startsAt?.toISOString(),
        expiresAt: e.expiresAt?.toISOString(),
        status: e.status,
        amountNaira: e.amountKobo != null ? e.amountKobo / 100 : null,
        note: e.note ?? '',
        byName: e.byName ?? '',
        createdAt: e.createdAt?.toISOString(),
      })),
    };
  }

  @Post('students/:id/pro')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Give a student Pro until a date (ambassadors, team, competition winners)' })
  async grant(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: GrantProDto) {
    const u = await this.users.findById(id).select('username role').lean().exec();
    if (!u || u.role) throw new BadRequestException('That student no longer exists.');
    const until = new Date(dto.until);
    if (until.getTime() <= Date.now()) throw new BadRequestException('Pick a date in the future.');
    await this.plans.grant(id, 'grant', until, { note: dto.note?.trim() || undefined, byName: staff.name });
    await this.auditLog.log(staff, 'student', id, 'pro_granted', `Gave @${u.username} Pro until ${until.toISOString().slice(0, 10)}${dto.note ? `: ${dto.note}` : ''}`);
    return this.studentPlan(id);
  }

  @Delete('pro-grants/:id')
  @RequirePermission('managePlans')
  @ApiOperation({ summary: 'Take back a Pro grant (purchases are refunded through the store, not here)' })
  async revoke(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: RevokeDto) {
    const found = await this.plans.entitlement(id);
    if (!found) throw new BadRequestException('That grant no longer exists.');
    if (found.source === 'play' || found.source === 'paystack') throw new BadRequestException('Purchases are refunded in Play Console / Paystack.');
    const e = await this.plans.revoke(id, staff.name, dto?.note);
    await this.auditLog.log(staff, 'student', String(e.userId), 'pro_revoked', `Took back a ${e.source.replace('_', ' ')} Pro grant`);
    return this.studentPlan(String(e.userId));
  }
}
