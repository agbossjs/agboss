import { frameworkPackageJson } from "@agboss/core/internal";
import { z } from "zod";

/** Where a public name lives now (#195): its entry and, when it was renamed, its new name. */
export interface Move {
  readonly entry: string;
  readonly name?: string;
}

/** What `agboss migrate imports` rewrites: whole entries that moved, and single names. */
export interface ImportMoves {
  /** A deprecated entry → the entry that replaced it: `"@agboss/core/core"` → `"@agboss/core"`. */
  readonly entries: Readonly<Record<string, string>>;
  /** Names that moved on their own or were renamed, by the entry they were imported from. */
  readonly names: Readonly<Record<string, Readonly<Record<string, Move>>>>;
}

const FrameworkPackage = z.object({
  name: z.string(),
  deprecatedExports: z.record(z.string(), z.string()).default({}),
});

/** `"./core"` → `"@agboss/core/core"`, `"."` → `"@agboss/core"`. */
const specifierOf = (name: string, subpath: string): string =>
  subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`;

/**
 * #261 PR 6: the observers and the cancel error are named after executions. The observers' manager
 * (`ObserverManager`, then `ExecutionObserverManager`) is internal since #834: no public name to move to.
 * The 0.1.0 `Router` type of `/core` (`RouterEngine`) is internal since #1313: it has no public home.
 */
const EXECUTION_NAMES: Readonly<Record<string, Move>> = {
  WorkflowObserver: { entry: "@agboss/core", name: "ExecutionObserver" },
  WorkflowCancelledError: { entry: "@agboss/core", name: "ExecutionCancelledError" },
};

/** One name per meaning (#195): the public names that were renamed or left the root entry. */
const RENAMED: ImportMoves["names"] = {
  "@agboss/core/core": {
    ...EXECUTION_NAMES,
  },
  "@agboss/core": {
    ...EXECUTION_NAMES,
    AutoApproveChannel: { entry: "@agboss/core/testing" }, // #1324d: the test channels left the root
    AutoRejectChannel: { entry: "@agboss/core/testing" },
    McpServer: { entry: "@agboss/core/mcp", name: "McpExpose" },
    McpServerOptions: { entry: "@agboss/core/mcp", name: "McpExposeOptions" },
    McpService: { entry: "@agboss/core/mcp" },
    McpSession: { entry: "@agboss/core/mcp" },
    createMcpService: { entry: "@agboss/core/mcp" },
  },
  "@agboss/core/testing": {
    Duration: { entry: "@agboss/core/testing", name: "ClockDuration" },
    TestClock: { entry: "@agboss/core/testing", name: "VirtualClock" }, // #262: the public test clock
    VCRMode: { entry: "@agboss/core/testing", name: "VcrMode" }, // #802: cased as VcrConfig
  },
};

/** The five entries 0.1.0 kept as deprecated re-exports of the root, removed in 0.1.1 (#1324d). */
const REMOVED_ENTRIES: readonly string[] = [
  "./core",
  "./graph",
  "./router",
  "./tool",
  "./channels",
];

/** The moves of the installed framework: the removed entries, its package.json's `deprecatedExports` + renames. */
export function frameworkMoves(): ImportMoves {
  const pkg = FrameworkPackage.parse(frameworkPackageJson());
  const pairs: readonly (readonly [string, string])[] = [
    ...REMOVED_ENTRIES.map((from): readonly [string, string] => [
      specifierOf(pkg.name, from),
      specifierOf(pkg.name, "."),
    ]),
    ...Object.entries(pkg.deprecatedExports).map(([from, to]): readonly [string, string] => [
      specifierOf(pkg.name, from),
      specifierOf(pkg.name, to),
    ]),
  ];
  const entries: Readonly<Record<string, string>> = Object.fromEntries(pairs);
  return { entries, names: RENAMED };
}

/** Where `name`, imported from `entry`, lives now; undefined when it did not move. */
export function moveOf(moves: ImportMoves, entry: string, name: string): Move | undefined {
  const renamed = moves.names[entry]?.[name];
  if (renamed !== undefined) return renamed;
  const replacement = moves.entries[entry];
  return replacement === undefined ? undefined : { entry: replacement };
}
