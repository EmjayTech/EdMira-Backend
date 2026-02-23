import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { User, userModel } from './model/user.model';
import { UsersService } from './user.service';

@Global()
@Module({
  providers: [UsersService],
  exports: [UsersService],
  imports: [
    JwtModule,
    MongooseModule.forFeatureAsync([
      {
        name: User.name,
        useFactory: () => {
          return userModel;
        },
      },
    ]),
  ],
})
export class UserModule {}