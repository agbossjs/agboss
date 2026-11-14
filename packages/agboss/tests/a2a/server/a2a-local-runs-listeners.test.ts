/** #1008 AC4: one listener that throws never stops the event reaching the others. */
import { describe, expect, it } from "vitest";
import { LocalRuns } from "../../../src/a2a/server/a2a-local-runs.js";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import type { FrameworkLog } from "../../../src/infrastructure/logger.js";

const KEY = { tenantId: "acme", taskId: "task-1" };
const STEP = { agent: "desk-agent", visit: 1, branch: "execution-1", attempt: 1 };

describe("#1008 AC4: LocalRuns' fan-out", () => {
  it("the second listener hears an event the first threw on; the throw is logged once per run, without the event", async () => {
    const warnings: { code: string; message: string; subject: unknown }[] = [];
    const log: FrameworkLog = {
      info: () => undefined,
      error: () => undefined,
      warn: (code, message, subject) => warnings.push({ code, message, subject }),
    };
    const runs = new LocalRuns(log);
    const heard: ExecutionStreamEvent[] = [];
    let emit: (event: ExecutionStreamEvent) => void = () => undefined;
    let finish = (): void => undefined;
    const settled = runs.start(KEY, (onStream) => {
      emit = onStream;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    runs.listen(KEY, () => {
      throw new Error("listener broke: SECRET-TEXT");
    });
    runs.listen(KEY, (event) => heard.push(event));

    emit({ kind: "textDelta", delta: "SECRET-TEXT", step: STEP });
    emit({ kind: "textDelta", delta: "more", step: STEP });
    finish();
    await settled;

    expect(heard.map((event) => (event.kind === "textDelta" ? event.delta : ""))).toEqual([
      "SECRET-TEXT",
      "more",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "stream.listener-failed",
      subject: { executionId: "task-1", tenantId: "acme" },
    });
    expect(JSON.stringify(warnings)).not.toContain("SECRET-TEXT");
  });
});
