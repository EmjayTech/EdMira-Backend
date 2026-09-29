import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { MockExamController } from './mock-exam.controller';
import { MockExam, MockExamSchema } from './mock-exam.schema';
import { MockExamService } from './mock-exam.service';

@Module({
  imports: [
    ContentModule,
    SubscriptionModule,
    MongooseModule.forFeature([{ name: MockExam.name, schema: MockExamSchema }]),
  ],
  controllers: [MockExamController],
  providers: [MockExamService],
})
export class MockExamModule {}
