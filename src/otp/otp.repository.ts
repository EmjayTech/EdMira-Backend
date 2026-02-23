import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Otp, OtpDocument } from './schema/otp.schema';

@Injectable()
export class OtpRepository {
  constructor(@InjectModel(Otp.name) private otpModel: Model<OtpDocument>) {}

  create(payload: Partial<Otp>) {
    return this.otpModel.create(payload);
  }

  findLatest(userId: string | Types.ObjectId) {
    return this.otpModel.findOne({ userId }).sort({ createdAt: -1 }).exec();
  }

  markUsed(otpId: string) {
    return this.otpModel.findByIdAndUpdate(otpId, { isUsed: true }, { new: true }).exec();
  }

  incrementAttempts(otpId: string) {
    return this.otpModel.findByIdAndUpdate(otpId, { $inc: { attempts: 1 } }, { new: true }).exec();
  }
}