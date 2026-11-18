import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { NotesController } from './notes.controller';
import { NotesPdfService } from './notes-pdf.service';
import { Course, CourseSchema } from './schemas/course.schema';
import { Question, QuestionSchema } from './schemas/question.schema';
import { Resource, ResourceSchema } from './schemas/resource.schema';
import { Topic, TopicSchema } from './schemas/topic.schema';
import { TopicVersion, TopicVersionSchema } from './schemas/topic-version.schema';
import { ContentAsset, ContentAssetSchema } from './schemas/content-asset.schema';
import { TopicVersionsService } from './topic-versions.service';
import { Curriculum, CurriculumSchema } from './schemas/curriculum.schema';
import { Contributor, ContributorSchema } from './schemas/contributor.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Course.name, schema: CourseSchema },
      { name: Topic.name, schema: TopicSchema },
      { name: Question.name, schema: QuestionSchema },
      { name: Resource.name, schema: ResourceSchema },
      { name: TopicVersion.name, schema: TopicVersionSchema },
      { name: ContentAsset.name, schema: ContentAssetSchema },
      { name: Curriculum.name, schema: CurriculumSchema },
      { name: Contributor.name, schema: ContributorSchema },
    ]),
  ],
  controllers: [ContentController, NotesController],
  providers: [ContentService, NotesPdfService, TopicVersionsService],
  exports: [ContentService, TopicVersionsService, MongooseModule],
})
export class ContentModule {}
