import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

/** Logs one line per request once the response finishes: method, url, status, time, user. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const user = (req as any).user?.sub ?? (req as any).user?.id ?? (req as any).user?._id;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms${user ? ` user=${user}` : ''}`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.log(line);
  });
  next();
}
