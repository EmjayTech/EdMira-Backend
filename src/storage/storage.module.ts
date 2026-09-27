import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FileStorageService } from './file-storage.service';

@Global()
@Module({
  controllers: [FilesController],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class StorageModule {}
