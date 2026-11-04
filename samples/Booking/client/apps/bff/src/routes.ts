import express from 'express';
import type { Request, Response } from 'express';
import { ReservationsApi } from './reservations-api';

const backend = new ReservationsApi(process.env.BOOKING_API ?? 'http://localhost:5000');

async function list(req: Request, res: Response) {
  res.json(await backend.list());
}

async function create(req: Request, res: Response) {
  res.status(201).json(await backend.create(req.body));
}

async function cancel(req: Request, res: Response) {
  await backend.cancel(String(req.query.id));
  res.sendStatus(204);
}

/** Edge case: the handlers put into an object by shorthand ({ list }) are referenced from here. */
export const handlers = { list, create, cancel };

/** Edge case: a chain of verbs over several lines, mounted at /api in server.ts: GET, POST and DELETE /api/reservations. */
export const apiRouter = express.Router();
apiRouter
  .route('/reservations')
  .get(list)
  .post(create)
  .delete(cancel);
