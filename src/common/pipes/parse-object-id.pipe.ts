import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';

/** Route ids must be Mongo ObjectIds; anything else is simply "not found". */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!Types.ObjectId.isValid(value)) throw new NotFoundException('Not found');
    return value;
  }
}
