/** The default `@Mesh({ maxHops })` (#398), and of an application with no `@Mesh`: at most 8 applications in one call chain. */
export const DEFAULT_MAX_MESH_HOPS = 8;

/** How long a trusted request's answer is kept by an application with no `@Mesh`: 30 minutes. */
export const DEFAULT_IDEMPOTENCY_RETENTION = 30 * 60 * 1000;

/** The default `@Mesh({ envelopeTtl })`: how long an envelope or header the application signs is valid, 60 seconds. */
export const ENVELOPE_LIFETIME = 60 * 1000;

/** The default `@Mesh({ maxClockSkew })`: how far a caller's clock may run from the receiver's, 30 seconds. */
export const CLOCK_SKEW = 30 * 1000;

/**
 * The recovery sweep's granularity, which a signed request's dedupe record is kept beyond its last
 * valid moment (#1320): the sweep removes expired rows once in a while, never to the millisecond.
 */
export const SWEEP_GRANULARITY = 60 * 1000;
