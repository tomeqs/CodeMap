import { Router } from 'express';
import { listProducts, productById } from './catalog.handlers';

export const catalogRouter = Router();

catalogRouter.get('/', listProducts);

catalogRouter.get('/:id', async (req, res) => {
  const product = await productById(req.params.id);
  if (!product) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.json(product);
});
