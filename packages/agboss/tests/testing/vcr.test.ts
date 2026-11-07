import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutionOutput } from "../../src/app/types.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import {
  callTool,
  CassetteMissingError,
  decideWith,
  replyWith,
  routeTo,
  TestSetupError,
  testWith,
  VcrMode,
  type VcrConfig,
} from "../../src/testing/index.js";
import * as testing from "../../src/testing/index.js";
import { cassetteFileOf, vcrModeOf } from "../../src/testing/vcr.js";
import {
  ChatStart,
  MainRouter,
  OrderStatus,
  Reply,
  Support,
  DeskApplication,
} from "./fixtures/desk.workflow.js";
import { usd } from "../../src/units/index.js";
import { recordDesk, recordRun } from "./fixtures/vcr-recording.js";
import {
  DecisionDesk,
  LUNA,
  DecisionDeskApplication,
} from "../judges/fixtures/decision-judged.workflow.js";
import { TaskStart } from "../judges/fixtures/judged.workflow.js";
import { execute } from "../helpers/flow.js";

const dir = mkdtempSync(join(tmpdir(), "vcr-"));
const cassette = { cassetteName: "desk-order", dir };
const file = cassetteFileOf(cassette);

/** A mode a JavaScript caller or a JSON file could give, typed as one. */
const untypedMode = (value: unknown): VcrMode => value as VcrMode;
const replay = testWith(DeskApplication, { vcr: { ...cassette, mode: VcrMode.REPLAY } });
let recorded: ExecutionOutput;

beforeAll(async () => {
  recorded = await recordDesk(file, "Where is order 42?", (book) => {
    book.scriptOf("router:main-router").thenReturn(routeTo(Support));
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(OrderStatus, { orderId: "42" }), replyWith("Shipped."));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AC1 (#204): VCR — record once, replay in CI without a model", () => {
  it("the cassette holds every model call: Jev decisions, guardrails and agent turns, by key", () => {
    const { interactions } = JSON.parse(readFileSync(file, "utf8")) as {
      interactions: { kind: string; key: string }[];
    };

    expect(interactions.map(({ kind, key }) => `${kind} ${key}`)).toEqual([
      "decide guardrail:prompt-injection-guardrail",
      "decision router:main-router",
      "decide guardrail:prompt-injection-guardrail",
      "chat agent:support-agent",
      "chat agent:support-agent",
    ]);
  });

  replay(
    "replays the recorded run with no script, no key and the network blocked",
    async ({ app }) => {
      const before = readFileSync(file, "utf8");

      const result = await execute(app, ChatStart, { text: "Where is order 42?" });

      expect(result).toFollowPath([ChatStart, MainRouter, Support, Reply]);
      expect(result).toFinishWith(Reply, { text: "Shipped." });
      expect(result.output).toEqual(recorded.output);
      expect(readFileSync(file, "utf8")).toBe(before);
    },
  );

  replay("a request the cassette does not hold fails loudly, naming the call", async ({ app }) => {
    const run = execute(app, ChatStart, { text: "Where is order 7?" });

    await expect(run).rejects.toBeInstanceOf(CassetteMissingError);
    await expect(run).rejects.toMatchObject({
      code: "test.cassette-missing",
      message: expect.stringContaining(
        "has no recording of this guardrail:prompt-injection-guardrail request",
      ),
    });
  });

  it("under CI a missing cassette fails before the test runs, and nothing is recorded", async () => {
    vi.stubEnv("CI", "true");
    const missing = { cassetteName: "never-recorded", dir };

    await expect(TestEnvironment.of(DeskApplication, { vcr: missing })).rejects.toMatchObject({
      name: "CassetteMissingError",
      code: "test.cassette-missing",
    });
    expect(existsSync(cassetteFileOf(missing))).toBe(false);
  });

  it("the mode: as given; REPLAY under CI; else AUTO", () => {
    const named = { cassetteName: "x" };

    expect(vcrModeOf(named, { CI: "true" })).toBe(VcrMode.REPLAY);
    expect(vcrModeOf(named, { CI: "1" })).toBe(VcrMode.REPLAY);
    expect(vcrModeOf(named, { CI: "false" })).toBe(VcrMode.AUTO);
    expect(vcrModeOf(named, {})).toBe(VcrMode.AUTO);
  });

  describe("#839: under CI no mode records against real models, unless AGBOSS_VCR_RECORD_IN_CI opts in", () => {
    const missing = { cassetteName: "never-recorded", dir };
    const refusal =
      /^\[vcr\.record-in-ci\] .* records against real models, and CI is set \(CI=true\): a CI run replays its cassettes — record without CI and commit the cassette, or set AGBOSS_VCR_RECORD_IN_CI=1 to record in this CI run on purpose( \(AGBOSS_VCR_RECORD_IN_CI=\S+ is no opt-in: 1 or true\))?$/u;

    it("AC2: each mode under CI set and unset — a cassette present and missing", () => {
      const ci = { CI: "true" };
      const optIn = { CI: "true", AGBOSS_VCR_RECORD_IN_CI: "1" };
      // CI unset: every mode as given
      for (const mode of Object.values(VcrMode)) {
        expect(vcrModeOf({ ...cassette, mode }, {})).toBe(mode);
        expect(vcrModeOf({ ...missing, mode }, { CI: "false" })).toBe(mode);
      }
      // CI set: the modes that only replay are taken
      expect(vcrModeOf({ ...cassette, mode: VcrMode.REPLAY }, ci)).toBe(VcrMode.REPLAY);
      expect(vcrModeOf({ ...missing, mode: VcrMode.REPLAY }, ci)).toBe(VcrMode.REPLAY);
      expect(vcrModeOf(cassette, ci)).toBe(VcrMode.REPLAY);
      expect(vcrModeOf({ ...cassette, mode: VcrMode.AUTO }, ci)).toBe(VcrMode.AUTO); // replays
      // CI set: every mode that calls real models is refused, naming the variables and the remedy
      expect(() => vcrModeOf({ ...cassette, mode: VcrMode.RECORD }, ci)).toThrow(refusal);
      expect(() => vcrModeOf({ ...cassette, mode: VcrMode.RECORD_STALE }, ci)).toThrow(refusal);
      expect(() => vcrModeOf({ ...missing, mode: VcrMode.AUTO }, ci)).toThrow(refusal);
      expect(() => vcrModeOf({ ...cassette, mode: VcrMode.RECORD }, ci)).toThrow(
        /^\[vcr\.record-in-ci\] vcr\.mode RECORD records/u,
      );
      expect(() => vcrModeOf({ ...missing, mode: VcrMode.AUTO }, ci)).toThrow(
        /^\[vcr\.record-in-ci\] vcr\.mode AUTO with no cassette at .* records/u,
      );
      expect(() => vcrModeOf(cassette, { ...ci, AGBOSS_VCR_MODE: "RECORD" })).toThrow(
        /^\[vcr\.record-in-ci\] AGBOSS_VCR_MODE=RECORD records/u,
      );
      for (const mode of [VcrMode.RECORD, VcrMode.RECORD_STALE, VcrMode.AUTO])
        expect(() => vcrModeOf({ ...missing, mode }, ci)).toThrow(TestSetupError);
      // the opt-in: "1" or "true", nothing else
      for (const mode of Object.values(VcrMode))
        expect(vcrModeOf({ ...missing, mode }, optIn)).toBe(mode);
      expect(
        vcrModeOf(
          { ...cassette, mode: VcrMode.RECORD },
          { ...ci, AGBOSS_VCR_RECORD_IN_CI: "TRUE" },
        ),
      ).toBe(VcrMode.RECORD);
      expect(() =>
        vcrModeOf({ ...cassette, mode: VcrMode.RECORD }, { ...ci, AGBOSS_VCR_RECORD_IN_CI: "yes" }),
      ).toThrow(/ \(AGBOSS_VCR_RECORD_IN_CI=yes is no opt-in: 1 or true\)$/u);
      for (const value of ["", "0", "false", "yes", "on"])
        expect(() =>
          vcrModeOf(
            { ...cassette, mode: VcrMode.RECORD },
            { ...ci, AGBOSS_VCR_RECORD_IN_CI: value },
          ),
        ).toThrow(refusal);
    });

    it("AC1: a test app recording under CI fails to build — no model asked, no cassette written", async () => {
      vi.stubEnv("CI", "true");
      vi.stubEnv("AGBOSS_VCR_RECORD_IN_CI", "");
      await expect(
        TestEnvironment.of(DeskApplication, { vcr: { ...missing, mode: VcrMode.RECORD } }),
      ).rejects.toThrow(refusal);
      await expect(
        TestEnvironment.of(DeskApplication, { vcr: { ...missing, mode: VcrMode.AUTO } }),
      ).rejects.toThrow(refusal);
      expect(existsSync(cassetteFileOf(missing))).toBe(false);
    });

    it("AC1: with the opt-in, a recording test app builds under CI", async () => {
      vi.stubEnv("CI", "true");
      vi.stubEnv("AGBOSS_VCR_RECORD_IN_CI", "1");
      const environment = await TestEnvironment.of(DeskApplication, {
        vcr: { ...missing, mode: VcrMode.RECORD },
      });
      // built: the providers' gateway is made on the first recorded call, none here
      expect(environment).toBeInstanceOf(TestEnvironment);
      await environment.close();
    });
  });

  it("#819 AC1: an unknown vcr.mode is refused, naming the modes — under CI, AGBOSS_VCR_MODE or neither", () => {
    for (const mode of ["replay", "PLAYBACK", "", 1, null])
      for (const env of [{}, { CI: "true" }, { AGBOSS_VCR_MODE: "REPLAY" }])
        expect(() => vcrModeOf({ cassetteName: "x", mode: untypedMode(mode) }, env)).toThrow(
          /^\[vcr\.unknown-mode\] vcr\.mode is .*: one of RECORD, REPLAY, AUTO, RECORD_STALE$/u,
        );
  });

  it("#819 AC1: a test app with an unknown vcr.mode fails to build — before any model is asked", async () => {
    await expect(
      TestEnvironment.of(DeskApplication, {
        vcr: { cassetteName: "unknown-mode", dir, mode: untypedMode("RECORDING") },
      }),
    ).rejects.toThrow(/\[vcr\.unknown-mode\]/u);
    expect(existsSync(cassetteFileOf({ cassetteName: "unknown-mode", dir }))).toBe(false);
  });

  it("#819 AC2: every mode of VcrMode is taken as it is", () => {
    for (const mode of Object.values(VcrMode))
      expect(vcrModeOf({ cassetteName: "x", mode }, {})).toBe(mode);
  });

  it("#802 AC3: VcrMode is the mode; the deprecated VCRMode is the same enum", () => {
    const alias = Object.entries(testing).find(([name]) => name === "VCRMode")?.[1];
    const config: VcrConfig = { cassetteName: "x", mode: VcrMode.REPLAY };

    expect(alias).toBe(VcrMode);
    expect(vcrModeOf(config, {})).toBe(VcrMode.REPLAY);
    expect(Object.values(VcrMode)).toEqual(["RECORD", "REPLAY", "AUTO", "RECORD_STALE"]);
  });
});

describe("#226: VCR records and replays a judge's decisions", () => {
  const judged = { cassetteName: "decision-judge", dir };
  const judgedFile = cassetteFileOf(judged);
  const replayJudged = testWith(DecisionDeskApplication, {
    vcr: { ...judged, mode: VcrMode.REPLAY },
  });
  let judgedRun: ExecutionOutput;

  beforeAll(async () => {
    judgedRun = await recordRun(
      { application: DecisionDeskApplication, start: TaskStart },
      judgedFile,
      "find a TS job",
      (book) => {
        book.scriptOf("agent:writer-agent").thenReturn(replyWith("Acme is hiring a TS engineer."));
        book
          .scriptOf("judge:answer-grounded")
          .thenReturn(
            decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }, { cost: usd(0.0003) }),
          );
      },
    );
  });

  replayJudged(
    "a judge on a decision model replays from the cassette with the network blocked",
    async ({ app }) => {
      const { interactions } = JSON.parse(readFileSync(judgedFile, "utf8")) as {
        interactions: { kind: string; key: string }[];
      };
      expect(interactions.map(({ kind, key }) => `${kind} ${key}`)).toContain(
        "decide judge:answer-grounded",
      );

      const result = await execute(app, TaskStart, { text: "find a TS job" });

      expect(result.output).toEqual({ text: "Acme is hiring a TS engineer." });
      const judgedSpend = (run: ExecutionOutput) =>
        run.spend.trace.filter((line) => line.caller === "judge:answer-grounded");
      expect(judgedSpend(result)).toMatchObject([{ model: LUNA, costUsd: 0.0003 }]);
      expect(judgedSpend(result)).toEqual(judgedSpend(judgedRun));
    },
  );
});
