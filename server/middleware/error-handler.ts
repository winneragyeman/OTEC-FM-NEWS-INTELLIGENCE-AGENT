import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

export function errorHandler(
  err: Error & { status?: number; statusCode?: number },
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const statusCode = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  logger.error({
    err,
    path: req.path,
    method: req.method,
    statusCode,
  }, 'Request error caught by global handler');

  res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal server error',
    ...(isProduction ? {} : { stack: err.stack }),
  });
}
