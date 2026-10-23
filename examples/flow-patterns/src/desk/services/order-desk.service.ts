import { Injectable } from "agboss";

/**
 * The orders the desk looks up — in memory here, a real system in production. Each status carries an
 * internal note after `|`, which `desk-audit-tool-interceptor` cuts before a model reads it.
 */
@Injectable()
export class OrderDeskService {
  statusOf(orderId: string): Promise<string> {
    return Promise.resolve(
      `order ${orderId} shipped on Monday | internal: carrier delay ticket 88`,
    );
  }

  /** One fast round trip, for the readiness probe. */
  isReachable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
