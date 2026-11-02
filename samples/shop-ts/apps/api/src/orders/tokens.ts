export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const CLOCK = 'CLOCK';
export const DISCOUNT_POLICIES = 'DISCOUNT_POLICIES';

export interface Clock {
  now(): Date;
}
