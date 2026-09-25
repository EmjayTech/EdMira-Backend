import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { Course, CourseSchema } from './schemas/course.schema';
import { Question, QuestionSchema } from './schemas/question.schema';
import { Topic, TopicSchema } from './schemas/topic.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Course.name, schema: CourseSchema },
      { name: Topic.name, schema: TopicSchema },
      { name: Question.name, schema: QuestionSchema },
    ]),
  ],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService, MongooseModule],
})
export class ContentModule {}
