import express from 'express';
import { apiRouter } from './routes';
import { register } from './register';

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
register(app);
app.listen(Number(process.env.PORT ?? 3000));
