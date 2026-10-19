import { beforeEach, describe, expect } from "vitest";
import { BranchStatus } from "../../../src/index.js";
import { replyWith, testWith, TestConcurrency } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  CompanyAuditAgent,
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningFailedWorkflowFinish,
  ScreeningWorkflowStart,
} from "../fixtures/launch.fixture.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { CompanyCheckDto, RankingDto } from "../fixtures/launch-dtos.js";
import { ScreeningApplication } from "./fixtures/launch.applications.js";
import {
  FanOutApplication,
  fanOut,
  ItemsWorkflowStart,
  resetFanOut,
  SummaryWorkflowFinish,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";

/** #273 AC2, AC10, AC12: one run per item of a list, in the list's order, at most `maxItems`. */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const screening = testWith(ScreeningApplication, REAL);
const items = testWith(FanOutApplication, REAL);

const item = (name: string, delay = 0): ItemDto => ({ name, delay, outcome: "ok" });
const companies = (...names: readonly string[]) =>
  replyWith(
    CompanyDto,
    names.map((name) => ({ name })),
  );
const check = (name: string) => replyWith(CompanyCheckDto, { name, passed: true });

beforeEach(resetFanOut);

describe("AC2: an agent per item", () => {
  screening("one run per item, its own item", async ({ app, mockLlm }) => {
    mockLlm(ScreeningAgent).thenReturn(companies("Acme", "Globex", "Initech"));
    mockLlm(CompanyAuditAgent).thenReturn(check("Acme"), check("Globex"), check("Initech"));
    mockLlm(RankerAgent).thenReturn(replyWith(RankingDto, { order: "Acme, Globex, Initech" }));

    const result = await app.execute(ScreeningWorkflowStart, { text: "tea makers" });

    expect(result).toFinishWith(RankingWorkflowFinish, { order: "Acme, Globex, Initech" });
    const asked = mockLlm(CompanyAuditAgent).requests.map((request) => request.input);
    expect(asked).toHaveLength(3);
    for (const name of ["Acme", "Globex", "Initech"]) {
      expect(asked.filter((input) => JSON.stringify(input).includes(name))).toHaveLength(1);
    }
    expect(result.path.filter((node) => node === "company-audit-agent")).toHaveLength(3);
    const ranked = JSON.stringify(mockLlm(RankerAgent).requests[0]?.input);
    expect(ranked).toContain("Initech");
  });

  screening(
    "a limit reached in a branch fails the launch into .onJoinError(LimitExceededError, …)",
    async ({ app, mockLlm }) => {
      const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
      mockLlm(ScreeningAgent).thenReturn(companies(...names));
      mockLlm(CompanyAuditAgent).thenReturnAlways(check("x"));

      const result = await app.execute(ScreeningWorkflowStart, { text: "many" });

      // maxSteps 9: the screening agent and eight audits; the ninth audit would be step 10
      expect(result).toFinishWith(ScreeningFailedWorkflowFinish, {
        reason: "stopped after 9 companies",
      });
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toContain(
        BranchStatus.Failed,
      );
    },
  );
});

describe("AC12: an action per item", () => {
  items("per-item action keys", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [item("a"), item("b"), item("c")]);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
    const keys = [...fanOut.keys].sort();
    expect(keys).toEqual([
      `${result.runId}:process-item-action:1:0`,
      `${result.runId}:process-item-action:1:1`,
      `${result.runId}:process-item-action:1:2`,
    ]);
    expect([...fanOut.items].sort()).toEqual([0, 1, 2]);
  });

  items(
    "order kept: the join lists the items' order, not the order they finished",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [item("slow", 40), item("fast", 0)]);

      expect(fanOut.events.indexOf("end fast")).toBeLessThan(fanOut.events.indexOf("end slow"));
      expect(result).toFinishWith(SummaryWorkflowFinish, { text: "slow, fast" });
    },
  );

  items("empty list: nothing is launched and the join gives [] at once", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, []);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "" });
    expect(fanOut.events).toEqual([]);
    expect(result.launches).toEqual([
      { launch: `${result.runId}:items-workflow-start:1`, items: 0, taken: 0, branches: [] },
    ]);
  });
});

describe("AC10: maxItems truncates, never fails", () => {
  items("truncated at maxItems, no error, recorded", async ({ app }) => {
    const six = ["a", "b", "c", "d", "e", "f"].map((name) => item(name));

    const result = await execute(app, ItemsWorkflowStart, six);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c, d" });
    expect(result.launches).toMatchObject([{ items: 6, taken: 4 }]);
    expect(fanOut.truncated).toMatchObject([
      {
        executionId: result.runId,
        launch: `${result.runId}:items-workflow-start:1`,
        items: 6,
        maxItems: 4,
        step: { nodeId: "items-workflow-start" },
        workflow: { name: "fan-out-workflow" },
      },
    ]);
  });
});
