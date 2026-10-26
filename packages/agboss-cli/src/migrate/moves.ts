import { frameworkPackageJson } from "@agboss/core/internal";
import { z } from "zod";

/** Where a public name lives now (#195): its entry and, when it was renamed, its new name. */
export interface Move {
  readonly entry: string;
  readonly name?: string;
}

/** What `agboss migrate imports` rewrites: whole entries that moved, and single names. */
export interface ImportMoves {
  /** A deprecated entry → the entry that replaced it: `"@agboss/core/core"` → `"agboss"`. */
  readonly entries: Readonly<Record<string, string>>;
  /** Names that moved on their own or were renamed, by the entry they were imported from. */
  readonly names: Readonly<Record<string, Readonly<Record<string, Move>>>>;
}

const FrameworkPackage = z.object({
  name: z.string(),
  deprecatedExports: z.record(z.string(), z.string()).default({}),
});

/** `"./core"` → `"@agboss/core/core"`, `"."` → `"agboss"`. */
const specifierOf = (name: string, subpath: string): string =>
  subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`;

/** #261 PR 6: the observers and the cancel error are named after executions. */
const EXECUTION_NAMES: Readonly<Record<string, Move>> = {
  WorkflowObserver: { entry: "@agboss/core", name: "ExecutionObserver" },
  ObserverManager: { entry: "@agboss/core", name: "ExecutionObserverManager" },
  WorkflowCancelledError: { entry: "@agboss/core", name: "ExecutionCancelledError" },
};

/** One name per meaning (#195): the public names that were renamed or left the root entry. */
const RENAMED: ImportMoves["names"] = {
  "@agboss/core/core": {
    Router: { entry: "@agboss/core", name: "RouterEngine" },
    ...EXECUTION_NAMES,
  },
  "@agboss/core": {
    ...EXECUTION_NAMES,
    McpServer: { entry: "@agboss/core/mcp", name: "McpExpose" },
    McpServerOptions: { entry: "@agboss/core/mcp", name: "McpExposeOptions" },
    McpService: { entry: "@agboss/core/mcp" },
    McpSession: { entry: "@agboss/core/mcp" },
    createMcpService: { entry: "@agboss/core/mcp" },
  },
  "@agboss/core/testing": {
    Duration: { entry: "@agboss/core/testing", name: "ClockDuration" },
    TestClock: { entry: "@agboss/core/testing", name: "VirtualClock" }, // #262: the public test clock
  },
};

/** The moves of the installed framework: its package.json's `deprecatedExports` + renames. */
export function frameworkMoves(): ImportMoves {
  const pkg = FrameworkPackage.parse(frameworkPackageJson());
  const entries = Object.fromEntries(
    Object.entries(pkg.deprecatedExports).map(([from, to]) => [
      specifierOf(pkg.name, from),
      specifierOf(pkg.name, to),
    ]),
  );
  return { entries, names: RENAMED };
}

/** Where `name`, imported from `entry`, lives now; undefined when it did not move. */
export function moveOf(moves: ImportMoves, entry: string, name: string): Move | undefined {
  const renamed = moves.names[entry]?.[name];
  if (renamed !== undefined) return renamed;
  const replacement = moves.entries[entry];
  return replacement === undefined ? undefined : { entry: replacement };
}
