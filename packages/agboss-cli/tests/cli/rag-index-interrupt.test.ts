import { describe, expect, it } from "vitest";
import { until } from "../../../agboss/tests/helpers/until.js";
import { interruptProbe } from "../fixtures/cli/rag-interrupt.application.js";
import { agboss, envelope, fixture } from "./agboss.js";

/**
 * #891 AC5: Ctrl+C stops `agboss rag index` — SIGINT aborts the signal the connector indexes
 * under (the connector's run leaves its index as it found it: `tests/rag/sqlite-fts-atomic-index`
 * in the core), the command exits 1 with `rag.interrupted`, and the signal's listeners go with it.
 */

const SLOW = fixture("cli/rag-interrupt.application.ts");

describe("#891 AC5: SIGINT interrupts agboss rag index", () => {
  it("AC5: SIGINT aborts the connector's index: exit 1, rag.interrupted, nothing reported as built", async () => {
    const probe = interruptProbe();
    probe.started = false;
    probe.aborted = false;
    const listeners = process.listenerCount("SIGINT");

    const call = agboss(["rag", "index", "--application", SLOW, "--json"]);
    await until(() => probe.started, "the index started");
    process.emit("SIGINT");
    const done = await call;

    expect(probe.aborted).toBe(true);
    expect(done.code).toBe(1);
    expect(envelope(done)).toMatchObject({ ok: false, error: { code: "rag.interrupted" } });
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });
});
