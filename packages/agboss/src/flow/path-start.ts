import type { DtoClass } from "../dto/types.js";
import type { ChildPlacement } from "./child-placement.js";
import type { GroupStart } from "./quorum-step.js";
import type { TargetRef } from "./target-ref.js";

/** How a builder's path begins: a source, a route, a case, or the side path of `.onError`. */
export type PathStart =
  | { readonly kind: "source" }
  | { readonly kind: "route"; readonly target: TargetRef; readonly placement?: ChildPlacement }
  | { readonly kind: "case"; readonly dto: DtoClass }
  | { readonly kind: "side" }
  | GroupStart;
