import type { DtoClass } from "../dto/types.js";
import type { TargetRef } from "./target-ref.js";

/** How a builder's path begins: a source, a route, a case, or a side path (`.onError`, `.onGroup`, …). */
export type PathStart =
  | { readonly kind: "source" }
  | { readonly kind: "route"; readonly target: TargetRef }
  | { readonly kind: "case"; readonly dto: DtoClass }
  | { readonly kind: "side" };
