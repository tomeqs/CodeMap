import { Router } from 'express';
import { api } from '../api-client';

export const ordersRouter = Router();

ordersRouter.post('/', async (req, res) => {
  const created = await api.post('/orders', req.body);
  res.status(201).json(created);
});

ordersRouter.post('/:id/pay', async (req, res) => {
  res.json(await api.post(`/orders/${encodeURIComponent(req.params.id)}/pay`, {}));
});
