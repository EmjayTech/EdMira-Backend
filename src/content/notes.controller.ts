import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { NotesPdfService, NotesScope } from './notes-pdf.service';

/**
 * Serves the notes PDFs behind the signed links from
 * GET /topics/:id/notes and GET /courses/:id/notes.
 */
@ApiExcludeController()
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesPdfService) {}

  @Public() // The signature is the permission; the app downloads without headers.
  @Get(':scope/:id')
  async download(
    @Param('scope') scope: string,
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    if (scope !== 'topic' && scope !== 'course') throw new BadRequestException();
    if (!/^[0-9a-f]{24}$/i.test(id) || !this.notes.verify(scope as NotesScope, id, Number(exp), sig)) {
      throw new NotFoundException('This download link has expired.');
    }
    const { name, doc } = await this.notes.build(scope as NotesScope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    doc.pipe(res);
  }
}
