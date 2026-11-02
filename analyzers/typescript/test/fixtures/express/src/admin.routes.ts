import { Router } from 'express';

// Mounted at /admin in server.ts, with routers of its own.
export const adminRouter = Router();

const cacheRouter = Router();
cacheRouter.delete('/', (req, res) => {
  res.status(204).end();
});
adminRouter.use('/cache', cacheRouter);

// Under a path the code computes: not /admin/daily, the route keeps the path it declares.
const reportsRouter = Router();
reportsRouter.get('/daily', (req, res) => {
  res.json([]);
});
const reports: string = process.env.REPORTS_PATH ?? '/reports';
adminRouter.use(reports, reportsRouter);
