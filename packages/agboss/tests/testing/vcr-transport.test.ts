import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { testWith, VCRMode, type TestApp } from "../../src/testing/index.js";
import { cassetteFileOf } from "../../src/testing/vcr.js";
import { execute } from "../helpers/flow.js";
import { EchoApplication, EchoLog, FIRST, SECOND } from "./fixtures/vcr-transport.fixture.js";

/**
 * #439: a VCR test records through a transport `@ModelProvider` (#385) — the recording gateway is
 * built as `createApp` builds its own: the chat extensions loaded, the transport created by the
 * test app's container on its first call, its hooks run first (#385 S4). A replay never creates it.
 */

interface StoredCassette {
  version: number;
  interactions: { kind: string; key: string; promptHash?: string }[];
}

const read = (file: string): StoredCassette =>
  JSON.parse(readFileSync(file, "utf8")) as StoredCassette;

const ANSWERS = [{ text: "answered by echo/first" }, { text: "answered by echo/second" }];

const dir = mkdtempSync(join(tmpdir(), "vcr-transport-"));
const cassette = { cassetteName: "echo", dir };
const file = cassetteFileOf(cassette);

const record = testWith(EchoApplication, { vcr: { ...cassette, mode: VCRMode.RECORD } });
const replay = testWith(EchoApplication, { vcr: { ...cassette, mode: VCRMode.REPLAY } });
/** The recording with the first agent's prompt changed since: written before its test opens it. */
const stale = { cassetteName: "echo-stale", dir };
const staleFile = cassetteFileOf(stale);
const recordStale = testWith(EchoApplication, { vcr: { ...stale, mode: VCRMode.RECORD_STALE } });

/** Both workflows once: one call of each agent. */
async function runBoth(app: TestApp): Promise<unknown[]> {
  const first = await execute(app, FIRST.start, { text: "hello" });
  const second = await execute(app, SECOND.start, { text: "again" });
  return [first.output, second.output];
}

// the three run in order: the recording, its replay, then a re-recording of one stale agent
describe("AC1: RECORD through a transport, REPLAY without it", () => {
  record(
    "records each agent's call from complete(), the transport started first",
    async ({ app }) => {
      const outputs = await runBoth(app);

      expect(outputs).toEqual(ANSWERS);
      expect(app.resolve(EchoLog).entries).toEqual([
        "onInit",
        "onStart",
        "complete echo/first",
        "complete echo/second",
      ]);
      expect(read(file).interactions.map(({ kind, key }) => `${kind} ${key}`)).toEqual([
        "chat agent:first-echo-agent",
        "chat agent:second-echo-agent",
      ]);
    },
  );

  replay("replays the cassette: the transport is never created or called", async ({ app }) => {
    const outputs = await runBoth(app);

    expect(outputs).toEqual(ANSWERS);
    expect(app.resolve(EchoLog).entries).toEqual([]);
  });
});

describe("AC2: RECORD_STALE records only the stale agent through the transport", () => {
  beforeAll(() => {
    const recorded = read(file);
    const changed = recorded.interactions.map((interaction) =>
      interaction.key === "agent:first-echo-agent"
        ? { ...interaction, promptHash: "0000000000000000" }
        : interaction,
    );
    writeFileSync(staleFile, JSON.stringify({ ...recorded, interactions: changed }));
  });

  recordStale("the first agent's calls anew, the second's replayed", async ({ app }) => {
    const kept = read(file).interactions.find((i) => i.key === "agent:second-echo-agent");

    const outputs = await runBoth(app);

    expect(outputs).toEqual(ANSWERS);
    expect(app.resolve(EchoLog).entries).toEqual(["onInit", "onStart", "complete echo/first"]);
    const after = read(staleFile).interactions;
    expect(after.find((i) => i.key === "agent:first-echo-agent")?.promptHash).not.toBe(
      "0000000000000000",
    );
    expect(after.find((i) => i.key === "agent:second-echo-agent")).toEqual(kept);
  });
});
