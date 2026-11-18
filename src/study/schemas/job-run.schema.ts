import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** A lock + record per scheduled-job run, so a run happens once even with several servers. */
@Schema({ collection: 'job_runs' })
export class JobRun {
  @Prop({ required: true }) job: string;
  /** e.g. the Lagos day of a nightly run. */
  @Prop({ required: true }) runKey: string;
  @Prop({ required: true }) startedAt: Date;
  @Prop() finishedAt?: Date;
  @Prop({ type: Object, default: undefined }) result?: Record<string, unknown>;
}

export type JobRunDocument = HydratedDocument<JobRun>;
export const JobRunSchema = SchemaFactory.createForClass(JobRun);
JobRunSchema.index({ job: 1, runKey: 1 }, { unique: true });
