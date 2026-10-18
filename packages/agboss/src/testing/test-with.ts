import { test, type Mocked, type TestAPI } from "vitest";
import type { ApplicationClass } from "../application/types.js";
import type { Class } from "../components/injection.js";
import type { McpServerClient, ServerTools } from "../components/mcp-client.js";
import { TestEnvironment, type TestWithOptions } from "./environment.js";
import type { McpStub } from "./mcp-stubs.js";
import { blockNetwork } from "./network-guard.js";
import type { ModelScript } from "./script-book.js";
import { createTestApp, type TestApp } from "./test-app.js";
import { chatKeyOf, type ModelTarget } from "./scripted-gateway.js";
import "./vitest-types.js";

/** What every test of `testWith(Application)` gets as its fixtures. */
export interface WorkflowFixtures {
  /** The application's real container and graphs, models and MCP scripted; built on first use. */
  readonly app: TestApp;
  /**
   * Closes the current app (its `onStop` hooks run, as on a real stop) and returns a new one over
   * the same test state (checkpoints, ledger, clock, ids) — "a paused run survives a restart".
   * The closed app fails every call with `test.app-closed`.
   */
  readonly recoverApp: () => Promise<TestApp>;
  /**
   * The script of an agent, a router or a `@Judge`'s model (by class):
   * `mockLlm(Scout).thenReturn(replyWith("…"))`, `mockLlm(AnswerGrounded).thenReturn(replyWith("PASS"))`.
   */
  readonly mockLlm: (component: ModelTarget) => ModelScript;
  /**
   * The script of the workflow's compaction model (`@Workflow({ compaction })`); unscripted, it
   * writes a fixed summary at no cost.
   */
  readonly mockCompaction: () => ModelScript;
  /** A typed mock injected instead of a component; the same instance the app uses. */
  readonly mockOf: <T>(component: Class<T>) => Mocked<T>;
  /** The stub of an MCP server: `mcpOf(ShortlistServer).thenReturn({ write_file: … })`. */
  readonly mcpOf: <TServer extends McpServerClient<ServerTools>>(
    server: new () => TServer,
  ) => McpStub<TServer>;
}

const COMPACTION_KEY = chatKeyOf({ kind: "compaction" });

interface Internal {
  readonly testSetup: { readonly application: Class; readonly options: TestWithOptions };
  readonly environment: TestEnvironment;
}

/**
 * A Vitest `test` for an application, like Spring's test context — the only form (#261): each test
 * gets the whole application assembled, with its real container, components, graph rules and the
 * infrastructure it lists (else the in-memory defaults), new per test, as `app`; models scripted
 * (`mockLlm`), MCP servers stubbed (`mcpOf`), the network blocked (`allowNetwork` to open hosts),
 * deterministic ids and a controllable clock. One workflow is tested through its start with
 * `app.execute`. `onStop` of real components runs after the test, also when it failed.
 * `const test = testWith(JobScoutApplication)`.
 */
export function testWith<TApplication extends Class>(
  application: ApplicationClass<TApplication>,
  options: TestWithOptions = {},
): TestAPI<WorkflowFixtures> {
  return test.extend<Internal & WorkflowFixtures>({
    testSetup: { application, options },
    environment: [
      async ({ testSetup }, use) => {
        const environment = await TestEnvironment.of(testSetup.application, testSetup.options);
        const unblock = blockNetwork({
          allowed: testSetup.options.allowNetwork ?? [],
          onBlocked: (error) => environment.book.report(error),
        });
        try {
          await use(environment);
        } finally {
          unblock();
          await environment.close();
        }
      },
      { auto: true },
    ],
    app: async ({ environment }, use) => {
      await use(createTestApp(environment));
    },
    recoverApp: async ({ environment, app }, use) => {
      let current = app;
      await use(async () => {
        await current.close();
        current = createTestApp(environment);
        return current;
      });
    },
    mockLlm: async ({ environment }, use) => {
      await use((component) => environment.mockLlm(component));
    },
    mockCompaction: async ({ environment }, use) => {
      await use(() => environment.book.scriptOf(COMPACTION_KEY));
    },
    mockOf: async ({ environment }, use) => {
      await use((component) => environment.mockOf(component));
    },
    mcpOf: async ({ environment }, use) => {
      await use((server) => environment.mcpOf(server));
    },
  });
}
