import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ACADEMIC_OPTIONS } from './academic-options';

@ApiTags('Reference')
@Controller('reference')
export class ReferenceController {
  @Public() // Needed on the sign-up screen, before the student has a token.
  @Get('academic-options')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Institution / faculty / department / level lists for sign-up' })
  academicOptions() {
    return ACADEMIC_OPTIONS;
  }
}
