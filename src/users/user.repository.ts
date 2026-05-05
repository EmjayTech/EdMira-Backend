import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from './model/user.model';


@Injectable()
export class UsersRepository {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) { }

  async create(userData: Partial<User>): Promise<UserDocument> {
    const user = new this.userModel(userData);
    return user.save();
  }

  findByEmail(email: string) {
    return this.userModel.findOne({ email }).exec();
  }

  findById(id: string | Types.ObjectId) {
    return this.userModel.findById(id).exec();
  }

  async markVerified(userId: string | Types.ObjectId) {
    return this.userModel
      .findByIdAndUpdate(userId, { isVerified: true }, { new: true })
      .exec();
  }

  async updatePassword(userId: string | Types.ObjectId, hashedPassword: string) {
    return this.userModel
      .findByIdAndUpdate(userId, { password: hashedPassword }, { new: true })
      .exec();
  }

  async updateRefreshToken(userId: string | Types.ObjectId, hashedRefreshToken: string) {
    return this.userModel
      .updateOne({ _id: userId }, { refreshToken: hashedRefreshToken })
      .exec();
  }

  async clearRefreshToken(userId: string | Types.ObjectId) {
    return this.userModel
      .updateOne({ _id: userId }, { refreshToken: null })
      .exec();
  }
}