import { Router } from 'express';
import { addLine, getOrder, listOrders } from './orders.handlers';
import { auth } from '../middleware/auth';

export const ordersRouter = Router();

ordersRouter.get('/', auth, listOrders);

ordersRouter.get('/:id', async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) {
    res.status(404).end();
    return;
  }
  res.json(order);
});

ordersRouter.route('/:id/lines').post(auth, (req, res) => {
  res.json(addLine(req.params.id, req.body));
});
