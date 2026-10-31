import { StoreClock, type Clock } from "../infrastructure/clock.js";

/**
 * A test's store clock (#533): every store, networked or not, decides by the test's clock — a seam
 * of tests only (`testWith`, the unit runners and the contract suites inject it), never production.
 */
export class TestStoreClock extends StoreClock {
  readonly isDatabaseTime: boolean = false;

  constructor(private readonly clock: Pick<Clock, "now">) {
    super();
  }

  now(): Date {
    return this.clock.now();
  }
}
