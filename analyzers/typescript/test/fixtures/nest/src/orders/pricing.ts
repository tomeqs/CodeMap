export interface Pricing {
  price(): number;
}

export class PricingService implements Pricing {
  price() {
    return 10;
  }
}
