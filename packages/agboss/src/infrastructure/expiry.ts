/** One kind of rows: what they are, how they are removed before a cutoff, and how long they stay. */
export interface Expiry {
  readonly what: string;
  /** Removes the rows older than the cutoff; the number removed when the store counts them (`deleteExpired`). */
  readonly remove: ((cutoff: Date) => Promise<number> | Promise<void>) | undefined;
  readonly retention: number | undefined;
}
