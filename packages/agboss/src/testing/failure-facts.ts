import type { Class } from "../components/injection.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/** The name a component has in executions, routes and results: its `name` (its node id). */
export const nodeNameOf = (target: Class): string =>
  declarationOf(target)?.options.name ?? target.name;
