import express from 'express';
import { catalogRouter } from './catalog/catalog.routes';
import { requestLog } from './middleware/request-log';
import { ordersRouter } from './orders/orders.routes';

export const app = express();
app.use(express.json());
app.use(requestLog);
app.use('/catalog', catalogRouter);
app.use('/orders', ordersRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(Number(process.env.PORT ?? 8080));
