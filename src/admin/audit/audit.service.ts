import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Staff } from '../staff.guard';
import { AuditEntity, AuditEntry, AuditEntryDocument } from './audit.schema';

const LIST_LIMIT = 1000;

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditEntry.name) private readonly audit: Model<AuditEntryDocument>) {}

  async log(staff: Staff, entity: AuditEntity, entityId: string, action: string, summary: string) {
    await this.audit.create({
      actorId: new Types.ObjectId(staff.id),
      actorName: staff.name,
      entity,
      entityId,
      action,
      summary,
    });
  }

  async list() {
    const entries = await this.audit.find().sort({ at: -1, _id: -1 }).limit(LIST_LIMIT).exec();
    return entries.map(e => ({
      id: e.id,
      at: e.at.toISOString(),
      actorId: String(e.actorId),
      actorName: e.actorName,
      entity: e.entity,
      entityId: e.entityId,
      action: e.action,
      summary: e.summary,
    }));
  }
}
