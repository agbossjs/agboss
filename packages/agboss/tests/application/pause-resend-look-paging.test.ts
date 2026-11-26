/**
 * #946: the re-send look pages by a keyset: more stuck replacements than one page — the first ones
 * another application's, never sent here — hide none behind them: every replacement this instance can
 * send is reached in one look.
 */
import { describe, expect, it } from "vitest";
import { RESEND_PAGE, ResendLook } from "../../src/application/pause-resend-look.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { pauseOf, withSeenNow } from "../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";

const NOT_OURS = RESEND_PAGE + 10;
const OURS = RESEND_PAGE + 20;

describe("#946: the re-send look reaches every stuck replacement", () => {
  it(`${String(NOT_OURS)} another application's replacements first, then ${String(OURS)} of ours: all of ours sent once`, async () => {
    const clock = new VirtualClock();
    const pauses = new InMemoryPausedExecutionRepository();
    const start = clock.now().getTime();
    const total = NOT_OURS + OURS;
    for (let index = 0; index < total; index += 1) {
      const old = `old-${String(index).padStart(3, "0")}`;
      await pauses.findOrCreateByStepKey({
        ...pauseOf(old, `run-${String(index)}:s:1:c`),
        rootExecutionId: `run-${String(index)}`,
      });
      await pauses.reassignByTenantIdAndPauseId(
        "default",
        old,
        await withSeenNow(pauses, old, {
          pauseId: `new-${String(index).padStart(3, "0")}`,
          assignees: ["deputy"],
        }),
        new Date(start + index * 1000),
        NO_RECIPIENTS,
      );
    }
    await clock.advance(hours(1));
    const sent: string[] = [];
    const look = new ResendLook({
      pauses,
      records: {
        findByTenantIdAndRunId: (_tenant, runId) =>
          Promise.resolve({
            workflow: Number(runId.slice(4)) < NOT_OURS ? "another-app" : "ours",
          } as never),
      },
      resends: new Map([
        [
          "ours",
          (pause) => {
            sent.push(pause.pauseId);
            return Promise.resolve();
          },
        ],
      ]),
      clock,
      log: { warn: () => undefined } as never,
      signal: new AbortController().signal,
    });

    await look.run();
    await look.settled();

    expect(sent.sort()).toEqual(
      Array.from({ length: OURS }, (_, i) => `new-${String(NOT_OURS + i).padStart(3, "0")}`),
    );
  });
});
