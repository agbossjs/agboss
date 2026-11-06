import { VcrMode } from "./vcr.js";

// The names kept for one release after a rename (#802), re-exported by `export *` so that no
// module of the core names them.

/**
 * The old casing of {@link VcrMode}: the same enum — its value, its type and its members as types.
 *
 * @deprecated Use {@link VcrMode} (cased as `VcrConfig` is); removed in 0.2.
 */
export import VCRMode = VcrMode;
