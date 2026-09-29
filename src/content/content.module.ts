import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { NotesController } from './notes.controller';
import { NotesPdfService } from './notes-pdf.service';
import { Course, CourseSchema } from './schemas/course.schema';
import { Question, QuestionSchema } from './schemas/question.schema';
import { Resource, ResourceSchema } from './schemas/resource.schema';
import { Topic, TopicSchema } from './schemas/topic.schema';

@Module({
  imports: [
    SubscriptionModule,
    MongooseModule.forFeature([
      { name: Course.name, schema: CourseSchema },
      { name: Topic.name, schema: TopicSchema },
      { name: Question.name, schema: QuestionSchema },
      { name: Resource.name, schema: ResourceSchema },
    ]),
  ],
  controllers: [ContentController, NotesController],
  providers: [ContentService, NotesPdfService],
  exports: [ContentService, MongooseModule],
})
export class ContentModule {}
