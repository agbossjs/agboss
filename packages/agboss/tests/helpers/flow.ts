import type { App, ExecutionOptions, ExecutionOutput } from "../../src/app/types.js";
import type { Class } from "../../src/components/injection.js";
import type { DtoClass } from "../../src/dto/types.js";
import { NodeKind, type PathSource } from "../../src/flow/ast.js";
import type { ReturnsOptions } from "../../src/flow/builder-types.js";
import {
  aboutTargets,
  fromComponent,
  fromSource,
  subPathFrom,
  type PathBuilder,
} from "../../src/flow/path-builder.js";

/**
 * The path builder without its compile-time checks, for the framework's own feature tests: the
 * same AST as `agboss`'s typed builder (tests/flow/builder.test.ts checks they agree), so a test
 * workflow needs no generated `.agboss/types.d.ts`. The typed builder is covered by the fixtures
 * under tests/flow/fixtures and the compile-time tests.
 */

export const start = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

export const agent = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Agent, source);

export const router = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Router, source);

export const action = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Action, source);

export const route = (target: Class): PathBuilder<undefined> =>
  subPathFrom({ kind: "route", target });

export const caseOf = (dto: DtoClass, options?: ReturnsOptions): PathBuilder<undefined> => {
  const about = aboutTargets(options);
  return subPathFrom(about === undefined ? { kind: "case", dto } : { kind: "case", dto, about });
};

const side = (): PathBuilder<undefined> => subPathFrom({ kind: "side" });

export const toAction = (target: Class): PathBuilder<undefined> =>
  side()
    .toAction(target);
export const toAgent = (target: Class): PathBuilder<undefined> =>
  side()
    .toAgent(target);
export const toRouter = (target: Class): PathBuilder<undefined> =>
  side()
    .toRouter(target);
export const toFinish = (target: Class): PathBuilder<undefined> =>
  side()
    .toFinish(target);

/** `app.execute` on a start whose types are not generated: the input is checked at run time only. */
export const execute = (
  app: Pick<App, "execute">,
  start: Class,
  input: unknown,
  options?: ExecutionOptions,
): Promise<ExecutionOutput> => app.execute(start, input as never, ...([options] as [never]));
