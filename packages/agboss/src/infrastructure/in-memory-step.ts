/**
 * One synchronous step of an in-memory store as a promise: a refusal (an Invalid Date, #1307) rejects
 * the promise, as every other store's does, and never throws before the promise exists.
 */
export const stepOf = <T>(step: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(step());
  });
