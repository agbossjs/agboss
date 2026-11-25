import type { ExecutionOutput } from "../app/types.js";
import { answerOpenPause, PauseNotOpenError } from "../eval/suite/answer-open-pause.js";
import { answerPause, replyToPause } from "../eval/suite/pauses.js";
import { withA2ATestServers } from "./a2a-server.js";
import { withMcpTestServers } from "./mcp-server.js";
import type { TestEnvironment } from "./environment.js";
import { TestFailure } from "./errors.js";
import type { TestApp } from "./test-app.js";
import type { WorkflowFixtures } from "./test-with.js";

/**
 * The fixtures of `testWith` that answer a pause and script the other boundaries (#1328): `answerPause`
 * and `replyToPause` — the eval builders' own, here answering the pause the test's last call left —
 * `mockRag` / `mockA2A`, and the A2A and MCP servers of the test's app.
 */

/** One fixture: built from the test's environment and app, handed to the test by `use`. */
type Fixture<TValue> = (
  context: { readonly environment: TestEnvironment; readonly app: TestApp },
  use: (value: TValue) => Promise<void>,
) => Promise<void>;

/** The pause the test's last call left, answered by the script; none open is `test.no-open-pause`. */
async function answeringOf(
  app: TestApp,
  environment: TestEnvironment,
  script: Parameters<typeof answerOpenPause>[2],
): Promise<ExecutionOutput> {
  const paused = environment.lastOutput;
  if (paused === undefined)
    throw new TestFailure({
      code: "test.no-open-pause",
      message: "nothing was executed yet: answer a pause after the execute that paused",
    });
  try {
    return await answerOpenPause(app, paused, script);
  } catch (error) {
    if (!(error instanceof PauseNotOpenError)) throw error;
    throw new TestFailure({ code: "test.no-open-pause", message: error.message, cause: error });
  }
}

/** The fixtures `testWith` adds beside its own. */
export const pauseAndBoundaryFixtures: {
  readonly answerPause: Fixture<WorkflowFixtures["answerPause"]>;
  readonly replyToPause: Fixture<WorkflowFixtures["replyToPause"]>;
  readonly mockRag: Fixture<WorkflowFixtures["mockRag"]>;
  readonly mockA2A: Fixture<WorkflowFixtures["mockA2A"]>;
  readonly mcpServer: Fixture<WorkflowFixtures["mcpServer"]>;
  readonly a2aServer: Fixture<WorkflowFixtures["a2aServer"]>;
} = {
  answerPause: async ({ app, environment }, use) => {
    await use((target, decision, options) =>
      answeringOf(app, environment, answerPause(target, decision, options)),
    );
  },
  replyToPause: async ({ app, environment }, use) => {
    await use((target, reply, options) =>
      answeringOf(app, environment, replyToPause(target, reply, options)),
    );
  },
  mockRag: async ({ environment }, use) => {
    await use((rag) => environment.mocks.mockRag(rag));
  },
  mockA2A: async ({ environment }, use) => {
    await use((agent) => environment.mocks.mockA2A(agent));
  },
  mcpServer: ({ app }, use) => withMcpTestServers(app, use),
  a2aServer: ({ app }, use) => withA2ATestServers(app, use),
};
