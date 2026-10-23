/** The default `@Application({ maxMeshHops })` (#398): at most 8 applications in one call chain. */
export const DEFAULT_MAX_MESH_HOPS = 8;

/** The default `@Application({ mesh: { idempotencyRetention } })`: 30 minutes. */
export const DEFAULT_IDEMPOTENCY_RETENTION = 30 * 60 * 1000;

/** How long an envelope the application signs is valid (`expiresIn`): 60 seconds. */
export const ENVELOPE_LIFETIME = 60 * 1000;

/** How far the caller's clock may run from the receiver's when an envelope is checked: 30 seconds. */
export const CLOCK_TOLERANCE = 30 * 1000;
