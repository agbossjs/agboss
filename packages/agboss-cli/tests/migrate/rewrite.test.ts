/**
 * #195: `agboss migrate imports` rewrites old deep imports to the new public entries — split by where
 * each name lives now, renamed names under their new name, merged per entry, suppressions removed.
 */
import { describe, expect, it } from "vitest";
import { frameworkMoves } from "../../src/migrate/moves.js";
import { migrateImports } from "../../src/migrate/rewrite.js";

/** The suppression the old deep imports needed (spelled in parts: the budget counts real ones). */
const DISABLE = ["// eslint-disable-next-line", "no-restricted-imports"].join(" ");
const moves = frameworkMoves();
const migrate = (text: string) => migrateImports(text, "src/x.ts", moves);

describe("migrateImports (#195)", () => {
  it("merges the old entries into one root import and drops their lint suppressions", () => {
    const before = [
      DISABLE,
      'import { Workflow, provide } from "agboss/core";',
      DISABLE,
      'import { from } from "agboss/router";',
      `${DISABLE} -- the settings builder`,
      'import { WorkflowSettings, type WorkflowDefinition } from "agboss/core";',
      'import { usd } from "agboss/units";',
      "// a comment that stays",
      'import { TerminalUserChannel } from "agboss/channels";',
      "",
      "export const x = 1;",
      "",
    ].join("\n");

    const after = migrate(before);

    expect(after.text).toBe(
      [
        'import { Workflow, provide, from, WorkflowSettings, type WorkflowDefinition, TerminalUserChannel } from "agboss";',
        'import { usd } from "agboss/units";',
        "// a comment that stays",
        "",
        "export const x = 1;",
        "",
      ].join("\n"),
    );
    expect(after).toMatchObject({ changed: true, warnings: [] });
  });

  it("imports renamed names under their new name and keeps the local name", () => {
    const after = migrate(
      [
        'import { Injectable, ROUTER_FACTORY, type Router } from "agboss/core";',
        'import type { Duration, TestClock } from "agboss/testing";',
        'import { testWith } from "agboss/testing";',
      ].join("\n"),
    );

    expect(after.text).toBe(
      [
        'import { Injectable, ROUTER_FACTORY, type RouterEngine as Router } from "agboss";',
        'import type { ClockDuration as Duration, VirtualClock as TestClock } from "agboss/testing";',
        'import { testWith } from "agboss/testing";',
      ].join("\n"),
    );
  });

  it("#261: the observer and cancel names follow executions; the local name is kept", () => {
    const after = migrate(
      [
        'import { ObserverManager, WorkflowCancelledError, type WorkflowObserver } from "agboss";',
        'import { type WorkflowObserver as Seen } from "agboss/core";',
      ].join("\n"),
    );

    expect(after.text).toBe(
      [
        'import { ExecutionObserverManager as ObserverManager, ExecutionCancelledError as WorkflowCancelledError, type ExecutionObserver as WorkflowObserver, type ExecutionObserver as Seen } from "agboss";',
      ].join("\n"),
    );
  });

  it("moves the MCP service names from the root to agboss/mcp, merging with what is there", () => {
    const after = migrate(
      [
        'import { McpTool } from "agboss/mcp";',
        'import { createApp, createMcpService, McpServer as Expose } from "agboss";',
      ].join("\n"),
    );

    expect(after.text).toBe(
      [
        'import { McpTool, createMcpService, McpExpose as Expose } from "agboss/mcp";',
        'import { createApp } from "agboss";',
      ].join("\n"),
    );
  });

  it("rewrites re-exports, type-only imports, namespaces, import() and import types", () => {
    const after = migrate(
      [
        'export { Agent as A, type Router } from "agboss/core";',
        'import type { ToolHandler } from "agboss/tool";',
        'import * as graph from "agboss/graph";',
        'import * as core from "agboss/core";',
        'import "agboss/channels";',
        'export type T = typeof import("agboss/tool");',
        'export const load = () => import("agboss/graph");',
      ].join("\n"),
    );

    expect(after.text).toBe(
      [
        'export { Agent as A, type RouterEngine as Router } from "agboss";',
        'import type { ToolHandler } from "agboss";',
        'import * as graph from "agboss";',
        'import * as core from "agboss";',
        'import "agboss";',
        'export type T = typeof import("agboss");',
        'export const load = () => import("agboss");',
      ].join("\n"),
    );
    // `core.Router` was the engine type: a namespace use of a renamed name needs a look by hand
    expect(after.warnings).toEqual([
      'src/x.ts:4: "agboss/core" as a whole — renamed or moved there: Router, WorkflowObserver, ObserverManager, WorkflowCancelledError; check them by hand',
    ]);
  });

  it("leaves current imports alone, and a second run changes nothing", () => {
    const current = [
      'import { Agent, Router } from "agboss";',
      'import { Agent as Other } from "agboss";',
      'import { Text } from "agboss/dto";',
      'import { helper } from "./helper.js";',
    ].join("\n");
    expect(migrate(current)).toEqual({ text: current, changed: false, warnings: [] });

    const once = migrate('import { Agent } from "agboss/core";\nimport { Agent } from "agboss";');
    expect(once.text).toBe('import { Agent } from "agboss";');
    expect(migrate(once.text).changed).toBe(false);
  });
});
