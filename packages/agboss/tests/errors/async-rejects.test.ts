/**
 * #1325a: every public method of `App`, `A2AClient`, `McpServerClient` and `Idempotency` that returns a
 * promise is `async`: a bad call rejects, it is never thrown at the call — what `Result.try(() => call)` and
 * a `.catch` both need. Each method is called with an argument no method takes.
 */
import { describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { A2AClient } from "../../src/a2a/index.js";
import { Idempotency } from "../../src/app/idempotency.js";
import { McpServerClient } from "../../src/components/mcp-client.js";
import { AGBossError, Result } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { FamilyRouteApplication } from "./family-routing.fixtures.js";

const test = testWith(FamilyRouteApplication);

const NOTHING = undefined as never;

/** The call settles as a promise; it does not throw at the call. */
async function rejectsNotThrows(call: () => unknown): Promise<void> {
  let returned: unknown;
  expect(() => {
    returned = call();
  }).not.toThrow();
  expect(returned).toBeInstanceOf(Promise);
  await (returned as Promise<unknown>).catch(() => undefined);
}

const ASYNC_METHODS = [
  "execute",
  "resume",
  "cancel",
  "setPauseTimeout",
  "reassignPause",
  "checkLiveness",
  "checkReadiness",
  "auditLogOf",
  "outboundCallsOf",
  "pendingOutboundCallsOf",
  "listPauses",
] as const satisfies readonly (keyof App)[];

describe("#1325a: a public async method rejects, it never throws at the call", () => {
  test("every promise-returning method of App, called with nothing it takes", async ({ app }) => {
    for (const name of ASYNC_METHODS) {
      const method = app[name] as (...args: never[]) => unknown;
      await rejectsNotThrows(() => method(NOTHING, NOTHING));
    }
  });

  test("a start of no workflow rejects with a framework error that Result.try keeps", async ({
    app,
  }) => {
    class Stranger {
      readonly label = "stranger";
    }

    const outcome = await Result.try(async () => app.execute(Stranger as never, {} as never));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error).toBeInstanceOf(AGBossError);
  });

  test("a bug — a start that is no class — is not dressed as a failure: it rejects as it is", async ({
    app,
  }) => {
    await expect(Result.try(async () => app.execute(NOTHING, NOTHING))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  test("A2AClient, Idempotency and McpServerClient", async () => {
    const client = new A2AClient({
      url: "http://127.0.0.1:1",
      fetcher: () => {
        throw new TypeError("no fetch");
      },
    });
    const idempotency = new Idempotency(NOTHING, NOTHING, NOTHING, {} as never, {} as never);
    class Server extends McpServerClient<never> {
      readonly label = "server";
    }

    await rejectsNotThrows(() => client.agentCard());
    await rejectsNotThrows(() => client.send(NOTHING));
    await rejectsNotThrows(() => client.execute(NOTHING));
    await rejectsNotThrows(() => idempotency.runOnce(NOTHING));
    await rejectsNotThrows(() => idempotency.sendOnce(NOTHING));
    await rejectsNotThrows(() => new Server().call(NOTHING, NOTHING));
  });
});
