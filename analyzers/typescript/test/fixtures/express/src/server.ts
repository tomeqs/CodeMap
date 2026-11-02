import express from 'express';
import { ordersRouter } from './orders/orders.routes';

const app = express();
app.use(express.json());
app.use('/orders', ordersRouter);
app.get('/health', (req, res) => {
  res.send('ok');
});
app.listen(3000);
