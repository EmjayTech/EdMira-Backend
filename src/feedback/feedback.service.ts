import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentService } from '../content/content.service';
import { CreateFeedbackDto, CreateReportDto } from './dto/feedback.dto';
import {
  Feedback,
  FeedbackDocument,
  QuestionReport,
  QuestionReportDocument,
} from './feedback.schemas';

@Injectable()
export class FeedbackService {
  constructor(
    @InjectModel(QuestionReport.name) private readonly reports: Model<QuestionReportDocument>,
    @InjectModel(Feedback.name) private readonly feedback: Model<FeedbackDocument>,
    private readonly content: ContentService,
  ) {}

  async reportQuestion(studentId: string, questionId: string, dto: CreateReportDto) {
    if (!(await this.content.questionExists(questionId))) {
      throw new NotFoundException('Question not found');
    }
    const report = await this.reports.create({
      questionId: new Types.ObjectId(questionId),
      topicId: new Types.ObjectId(dto.topicId),
      studentId: new Types.ObjectId(studentId),
      reason: dto.reason,
      note: dto.note?.trim() ?? '',
    });
    return { id: report.id };
  }

  async sendFeedback(studentId: string, dto: CreateFeedbackDto) {
    const item = await this.feedback.create({
      studentId: new Types.ObjectId(studentId),
      area: dto.area,
      rating: dto.rating ?? null,
      message: dto.message.trim(),
    });
    return { id: item.id };
  }
}
