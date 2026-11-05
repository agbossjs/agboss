import { VcrMode } from "./vcr.js";

// The names kept for one release after a rename (#802), re-exported by `export *` so that no
// module of the core names them.

/**
 * The old casing of {@link VcrMode}: the same enum.
 *
 * @deprecated Use {@link VcrMode} (cased as `VcrConfig` is); removed in 0.2.
 */
export const VCRMode = VcrMode;
/**
 * The old casing of {@link VcrMode}: the same type.
 *
 * @deprecated Use {@link VcrMode} (cased as `VcrConfig` is); removed in 0.2.
 */
export type VCRMode = VcrMode;
