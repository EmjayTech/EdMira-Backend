import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QuizAttempt, QuizAttemptSchema } from '../quiz/quiz-attempt.schema';
import { GooglePlayClient } from './google-play.client';
import { SubscriptionController } from './subscription.controller';
import { Subscription, SubscriptionSchema } from './subscription.schema';
import { SubscriptionService } from './subscription.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Subscription.name, schema: SubscriptionSchema },
      // Registered here too (not imported from QuizModule) to count today's
      // quizzes without a Content → Subscription → Quiz → Content cycle.
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
    ]),
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, GooglePlayClient],
  exports: [SubscriptionService, GooglePlayClient],
})
export class SubscriptionModule {}
