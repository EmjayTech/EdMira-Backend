import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, userModel } from './model/user.model';
import { UsersService } from './user.service';
import { UsersRepository } from './user.repository';
import { UsernameService } from './username.service';
import { UsernameHistory, UsernameHistorySchema } from './schema/username-history.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: User.name,
        useFactory: () => {
          return userModel;
        },
      },
    ]),
    MongooseModule.forFeature([{ name: UsernameHistory.name, schema: UsernameHistorySchema }]),
  ],
  providers: [UsersService, UsersRepository, UsernameService],
  exports: [UsersService, UsersRepository, UsernameService, MongooseModule],
})
export class UserModule { }