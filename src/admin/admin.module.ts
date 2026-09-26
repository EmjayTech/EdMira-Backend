import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { NewsModule } from '../news/news.module';
import { QuizModule } from '../quiz/quiz.module';
import { AdminContentService } from './admin-content.service';
import { AdminNewsService } from './admin-news.service';
import { AdminPeopleService } from './admin-people.service';
import { AdminController } from './admin.controller';
import { AuditEntry, AuditEntrySchema } from './audit/audit.schema';
import { AuditService } from './audit/audit.service';
import { StaffGuard } from './staff.guard';

@Module({
  imports: [
    ContentModule,
    QuizModule,
    FeedbackModule,
    NewsModule,
    MongooseModule.forFeature([{ name: AuditEntry.name, schema: AuditEntrySchema }]),
  ],
  controllers: [AdminController],
  providers: [AdminContentService, AdminNewsService, AdminPeopleService, AuditService, StaffGuard],
})
export class AdminModule {}
