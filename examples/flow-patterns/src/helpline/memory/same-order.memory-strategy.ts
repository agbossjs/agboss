import { Injectable } from "agboss";
import { BaseMemoryStrategy, type MemoryContext, type MemoryView } from "agboss/memory";

/** The `#<id>` orders a text names. */
const ordersIn = (text: string): readonly string[] => text.match(/#[\w-]+/gu) ?? [];

/**
 * What the helpline's agent remembers of the thread (`@Agent({ memoryStrategy })`): only the
 * earlier turns about an order this message names — a caller asking about #7 does not get the talk
 * about #9 in its context. No summaries: a thread's other orders stay out of it too.
 */
@Injectable()
export class SameOrderMemoryStrategy extends BaseMemoryStrategy {
  buildContext({ task, history }: MemoryContext): MemoryView {
    const orders = ordersIn(task);
    return {
      history: history.filter((turn) =>
        ordersIn(turn.start).some((order) => orders.includes(order)),
      ),
      summaries: [],
    };
  }
}
