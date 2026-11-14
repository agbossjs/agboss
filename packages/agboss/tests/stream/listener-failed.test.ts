/**
 * #1008 AC3: a throwing `onStream` listener is reported once per execution through the application's
 * `Logger` — a stable code, the execution and tenant ids, never the text — and the run goes on.
 */
import { describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { LogLevel } from "../../src/infrastructure/logger.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { deltas, AuditJudge, AuditStart, AuditWorkflow, AuditWriter } from "./writer.fixture.js";

@Application({
  name: "listener-log-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AuditWorkflow],
  providers: [...MODEL_PROVIDERS, RecordingLogger],
  budgets: TEST_BUDGETS,
})
class ListenerLogApplication {}

const test = testWith(ListenerLogApplication);

describe("#1008 AC3: a listener that throws", () => {
  test("is logged once with its code and the ids, never the text; the run completes and every event is still delivered", async ({
    app,
    mockLlm,
  }) => {
    resetLogged();
    mockLlm(AuditWriter).thenReturn(replyWith("Shipped on Friday."));
    mockLlm(AuditJudge).thenReturn(replyWith("PASS"));
    const heard: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      AuditStart,
      { text: "Q" },
      {
        onStream: (event) => {
          heard.push(event);
          throw new Error("listener broke: Shipped on Friday.");
        },
      },
    );

    expect(done.output).toEqual({ text: "Shipped on Friday." });
    expect(deltas(heard).join("")).toBe("Shipped on Friday.");
    const failed = logged.filter((entry) => entry.code === "stream.listener-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: LogLevel.Warn,
      executionId: done.executionId,
      tenantId: "default",
    });
    expect(JSON.stringify(failed)).not.toContain("Friday");
  });
});
