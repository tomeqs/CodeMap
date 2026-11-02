import type { NextFunction, Request, Response } from 'express';

export function requestLog(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started} ms`));
  next();
}
