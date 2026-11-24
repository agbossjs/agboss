/** One kind of rows: what they are, how they are removed before a cutoff, and how long they stay. */
export interface Expiry {
  readonly what: string;
  readonly remove: ((cutoff: Date) => Promise<void>) | undefined;
  readonly retention: number | undefined;
}
