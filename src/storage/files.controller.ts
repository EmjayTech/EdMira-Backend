import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { extname } from 'path';
import { Public } from '../common/decorators/public.decorator';
import { ALLOWED_UPLOAD_TYPES, FileStorageService } from './file-storage.service';

/**
 * Serves locally stored uploads (dev / tests only) behind the signed links
 * FileStorageService hands out. With cloud storage, links point there instead.
 */
@ApiExcludeController()
@Controller('files')
export class FilesController {
  constructor(private readonly storage: FileStorageService) {}

  @Public() // The signature is the permission; the app downloads without headers.
  @Get('materials/:file')
  download(
    @Param('file') file: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('name') name: string | undefined,
    @Res() res: Response,
  ) {
    const path = this.storage.localPath(`materials/${file}`, Number(exp), sig);
    if (!path || !existsSync(path)) throw new NotFoundException('This download link has expired.');
    res.type(ALLOWED_UPLOAD_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.download(path, name || file);
  }
}
