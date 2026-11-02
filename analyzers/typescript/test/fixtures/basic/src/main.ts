import { OrdersService, SqlOrdersRepository } from './index.js';
import express from 'express';
import './styles.css';

const service = new OrdersService(new SqlOrdersRepository());
service.place('1', [1, 2]);
express();
