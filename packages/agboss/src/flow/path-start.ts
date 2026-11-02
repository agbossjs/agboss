import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { ChildPlacement } from "./child-placement.js";
import type { GroupStart } from "./quorum-step.js";

/** How a builder's path begins: a source, a route, a case, or the side path of `.onError`. */
export type PathStart =
  | { readonly kind: "source" }
  | { readonly kind: "route"; readonly target: Class; readonly placement?: ChildPlacement }
  | { readonly kind: "case"; readonly dto: DtoClass; readonly about?: readonly DtoClass[] }
  | { readonly kind: "side" }
  | GroupStart;
