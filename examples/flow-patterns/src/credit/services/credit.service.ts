import { Injectable } from "agboss";

/** What a credit-limit lookup asks: whose limit, under which idempotency key. */
export interface CreditLimitRequest {
  readonly customerId: string;
  /** The same key on a retry of the same step: the lookup is made once. */
  readonly requestKey: string;
}

/** The customers' credit limits, in whole dollars (a service: the I/O a code router calls). */
@Injectable()
export class CreditService {
  limitOf({ customerId }: CreditLimitRequest): Promise<number> {
    return Promise.resolve(customerId === "big-spender" ? 10_000 : 100);
  }
}
