import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ContentModule } from '../content/content.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { StudyModule } from '../study/study.module';
import { HomeService } from './home.service';

@ApiTags('Home')
@ApiBearerAuth()
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Everything the Home screen needs in one request: greeting, streak, weekly goal, continue learning, focus area, Question of the Day and leaderboard line. Cached 60 s per student.',
  })
  summary(@GetCurrentUser('userId') userId: string) {
    return this.home.summary(userId);
  }
}

@Module({
  imports: [StudyModule, LeaderboardModule, ContentModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
