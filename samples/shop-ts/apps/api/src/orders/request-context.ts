import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

/** Who is asking: one per HTTP request. */
@Injectable({ scope: Scope.REQUEST })
export class RequestContext {
  constructor(@Inject(REQUEST) private readonly request: { headers: Record<string, string | undefined> }) {}

  customerId() {
    return this.request.headers['x-customer-id'] ?? 'guest';
  }
}
