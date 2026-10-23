/**
 * #395 PR 4: cassette v2 — every interaction keeps its component and that component's
 * `promptHash` / `schemaHash`; a replay of a component that changed since is a
 * `StaleCassetteError` (`vcr.stale-cassette`), `VCRMode.RECORD_STALE` (or `AGBOSS_VCR_MODE`)
 * records only the stale components anew, a version 1 cassette still replays with a hint, and
 * `checkCassettes` (`agboss check --cassettes`) gives the same verdict without a test.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import {
  callTool,
  CassetteChange,
  replyWith,
  routeTo,
  StaleCassetteError,
  TestSetupError,
  testWith,
  VCRMode,
} from "../../src/testing/index.js";
import { Cassette } from "../../src/testing/vcr-cassette.js";
import { checkCassettes, cassetteFilesUnder } from "../../src/testing/vcr-check.js";
import { cassetteFileOf, vcrModeOf } from "../../src/testing/vcr.js";
import { cassetteHashesOf, type CassetteHashes } from "../../src/testing/vcr-hashes.js";
import { execute } from "../helpers/flow.js";
import {
  ChatStart,
  DeskApplication,
  MainRouter,
  OrderStatus,
  Reply,
  Support,
} from "./fixtures/desk.workflow.js";
import { recordRun } from "./fixtures/vcr-recording.js";

interface StoredInteraction {
  kind: string;
  key: string;
  component?: string;
  promptHash?: string;
  schemaHash?: string;
}

interface StoredCassette {
  version: number;
  interactions: StoredInteraction[];
}

const read = (file: string): StoredCassette =>
  JSON.parse(readFileSync(file, "utf8")) as StoredCassette;

const write = (file: string, content: StoredCassette): void => {
  writeFileSync(file, JSON.stringify(content, null, 2));
};

const DESK = { application: DeskApplication, start: ChatStart };
const QUESTION = "Where is order 42?";

/** The whole run scripted: the router, then the agent's lookup and answer. */
const scriptAll = (book: Parameters<Parameters<typeof recordRun>[3]>[0]): void => {
  book.scriptOf("router:main-router").thenReturn(routeTo(Support));
  book
    .scriptOf("agent:support-agent")
    .thenReturn(callTool(OrderStatus, { orderId: "42" }), replyWith("Shipped."));
};

/** A cassette as if the support agent's prompt had changed after it was recorded. */
const withChangedAgent = (content: StoredCassette): StoredCassette => ({
  ...content,
  interactions: content.interactions.map((interaction) =>
    interaction.key === "agent:support-agent"
      ? { ...interaction, promptHash: "0000000000000000" }
      : interaction,
  ),
});

const dir = mkdtempSync(join(tmpdir(), "vcr-stale-"));
const cassette = { cassetteName: "desk", dir };
const file = cassetteFileOf(cassette);
const replay = testWith(DeskApplication, { vcr: { ...cassette, mode: VCRMode.REPLAY } });
/** The same recording with the agent changed since: written before each test opens it. */
const staleCassette = { cassetteName: "desk-stale", dir };
const replayStale = testWith(DeskApplication, { vcr: { ...staleCassette, mode: VCRMode.REPLAY } });

beforeEach(async () => {
  rmSync(join(dir, "nested"), { recursive: true, force: true });
  rmSync(join(dir, "old.cassette.json"), { force: true });
  await recordRun(DESK, file, QUESTION, scriptAll);
  write(cassetteFileOf(staleCassette), withChangedAgent(read(file)));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a version 2 cassette keeps each call's component and its hashes", () => {
  it("an agent's, a router's and a guardrail's calls carry their join keys (#395 PR 5b)", () => {
    const { version, interactions } = read(file);

    expect(version).toBe(2);
    const agent = interactions.find((i) => i.key === "agent:support-agent");
    const router = interactions.find((i) => i.key === "router:main-router");
    const guardrail = interactions.find((i) => i.key.startsWith("guardrail:"));
    expect(agent).toMatchObject({ component: "support-agent" });
    expect(agent?.promptHash).toMatch(/^[0-9a-f]+$/);
    // a text agent reads and writes no DTO: no schemaHash
    expect(agent?.schemaHash).toBeUndefined();
    expect(router).toMatchObject({ component: "main-router" });
    expect(router?.promptHash).toMatch(/^[0-9a-f]+$/);
    expect(guardrail?.component).toBe("prompt-injection-guardrail");
    expect(guardrail?.promptHash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("a replay of a changed component", () => {
  replay("an unchanged cassette replays", async ({ app }) => {
    const result = await execute(app, ChatStart, { text: QUESTION });

    expect(result).toFinishWith(Reply, { text: "Shipped." });
  });

  replayStale("the run fails with StaleCassetteError, naming the component", async ({ app }) => {
    const run = execute(app, ChatStart, { text: QUESTION });

    await expect(run).rejects.toBeInstanceOf(StaleCassetteError);
    await expect(run).rejects.toMatchObject({
      code: "vcr.stale-cassette",
      component: "support-agent",
      changes: [CassetteChange.Prompt],
      message: expect.stringContaining("AGBOSS_VCR_MODE=RECORD_STALE npm test"),
    });
  });

  it("the message says never to edit a cassette by hand, then to run the evals", async () => {
    write(file, withChangedAgent(read(file)));
    const opened = Cassette.replaying(file, await hashesOfDesk(), (failure) => failure);

    expect(() => opened.chat("agent:support-agent", "any")).toThrow(
      /never edit a cassette by hand\), then run the evals/,
    );
  });
});

async function hashesOfDesk(): Promise<CassetteHashes> {
  return cassetteHashesOf((await applicationOf(DeskApplication)).workflows);
}

describe("VCRMode.RECORD_STALE", () => {
  it("records the stale component's calls anew and keeps the others as recorded", async () => {
    const changed = withChangedAgent(read(file));
    write(file, changed);
    const routerBefore = changed.interactions.filter((i) => i.key === "router:main-router");

    // only the agent is scripted: a router call that was not replayed would fail unscripted
    const result = await recordRun(
      DESK,
      file,
      QUESTION,
      (book) => {
        book
          .scriptOf("agent:support-agent")
          .thenReturn(callTool(OrderStatus, { orderId: "42" }), replyWith("On its way."));
      },
      (at, hashes) => Cassette.recordingStale(at, hashes, (failure) => failure),
    );

    expect(result).toFollowPath([ChatStart, MainRouter, Support, Reply]);
    expect(result).toFinishWith(Reply, { text: "On its way." });
    const after = read(file);
    const fresh = await hashesOfDesk();
    const agent = after.interactions.filter((i) => i.key === "agent:support-agent");
    expect(agent).toHaveLength(2);
    expect(agent.every((i) => i.promptHash === fresh.of("agent:support-agent").promptHash)).toBe(
      true,
    );
    expect(after.interactions.filter((i) => i.key === "router:main-router")).toEqual(routerBefore);
  });

  it("is chosen by AGBOSS_VCR_MODE, over the test's own mode; a wrong value names the modes", () => {
    const named = { cassetteName: "x", mode: VCRMode.REPLAY };

    expect(vcrModeOf(named, { AGBOSS_VCR_MODE: "RECORD_STALE" })).toBe(VCRMode.RECORD_STALE);
    expect(vcrModeOf(named, { AGBOSS_VCR_MODE: "RECORD", CI: "true" })).toBe(VCRMode.RECORD);
    expect(vcrModeOf(named, { AGBOSS_VCR_MODE: "" })).toBe(VCRMode.REPLAY);
    expect(() => vcrModeOf(named, { AGBOSS_VCR_MODE: "record-stale" })).toThrow(TestSetupError);
    expect(() => vcrModeOf(named, { AGBOSS_VCR_MODE: "nope" })).toThrow(
      "AGBOSS_VCR_MODE=nope is not a VCR mode: one of RECORD, REPLAY, AUTO, RECORD_STALE",
    );
  });
});

describe("a version 1 cassette", () => {
  it("replays without stale detection and hints once how to upgrade it", async () => {
    const { interactions } = withChangedAgent(read(file));
    const v1 = interactions.map(({ component, promptHash, schemaHash, ...rest }) => {
      expect([component, promptHash, schemaHash].length).toBe(3);
      return rest;
    });
    write(file, { version: 1, interactions: v1 });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const hashes = await hashesOfDesk();

    const first = Cassette.replaying(file, hashes, (failure) => failure);
    Cassette.replaying(file, hashes, (failure) => failure);

    expect(() => first.chat("agent:support-agent", "unrecorded")).toThrow(
      "has no recording of this agent:support-agent request",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("version 1 cassette");
  });
});

describe("checkCassettes — agboss check --cassettes", () => {
  it("finds the project's cassettes and reports a stale one, a version 1 one and a broken one", async () => {
    const { workflows } = await applicationOf(DeskApplication);
    expect(checkCassettes([file], workflows)).toEqual({
      stale: [],
      hints: [],
      unreadable: [],
    });

    write(file, withChangedAgent(read(file)));
    const old = join(dir, "old.cassette.json");
    write(old, { version: 1, interactions: [] });
    const broken = join(dir, "nested", "broken.cassette.json");
    mkdirSync(join(dir, "nested"));
    writeFileSync(broken, JSON.stringify({ version: 9 }));

    const found = checkCassettes(cassetteFilesUnder(dir), workflows);

    expect(found.stale).toMatchObject([
      { file: cassetteFileOf(staleCassette), component: "support-agent" },
      { file, component: "support-agent", changes: [CassetteChange.Prompt] },
    ]);
    expect(found.stale[0]?.message).toContain("AGBOSS_VCR_MODE=RECORD_STALE npm test");
    expect(found.hints).toEqual([expect.stringContaining(`${old} is a version 1 cassette`)]);
    expect(found.unreadable).toMatchObject([{ file: broken }]);
  });

  it("a component the application no longer has is stale too", async () => {
    const content = read(file);
    write(file, {
      ...content,
      interactions: content.interactions.map((i) =>
        i.key === "router:main-router"
          ? { ...i, key: "router:gone-router", component: "gone-router" }
          : i,
      ),
    });
    const { workflows } = await applicationOf(DeskApplication);

    expect(checkCassettes([file], workflows).stale).toMatchObject([
      { component: "gone-router", changes: [CassetteChange.Removed] },
    ]);
  });
});
