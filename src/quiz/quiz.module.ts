import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { StudyModule } from '../study/study.module';
import { QuizAttempt, QuizAttemptSchema } from './quiz-attempt.schema';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

@Module({
  imports: [
    ContentModule,
    StudyModule,
    MongooseModule.forFeature([{ name: QuizAttempt.name, schema: QuizAttemptSchema }]),
  ],
  controllers: [QuizController],
  providers: [QuizService],
  exports: [MongooseModule, QuizService],
})
export class QuizModule {}
