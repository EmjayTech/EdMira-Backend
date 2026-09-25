import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { FeedbackController } from './feedback.controller';
import {
  Feedback,
  FeedbackSchema,
  QuestionReport,
  QuestionReportSchema,
} from './feedback.schemas';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [
    ContentModule,
    MongooseModule.forFeature([
      { name: QuestionReport.name, schema: QuestionReportSchema },
      { name: Feedback.name, schema: FeedbackSchema },
    ]),
  ],
  controllers: [FeedbackController],
  providers: [FeedbackService],
  exports: [MongooseModule],
})
export class FeedbackModule {}
