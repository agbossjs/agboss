/**
 * #262 PR 3 (S55, S62): `testTool` — one tool on its own, as an agent's tool call runs it: its
 * container (`overrides`), the frame of a tool call (`signal` with its timeout, `SpendRecorder`),
 * the input and the output validated.
 */
import { describe, expect, it } from "vitest";
import { DtoValidationError } from "../../../src/dto/index.js";
import { override, testTool } from "../../../src/testing/index.js";
import { ToolTimeoutError } from "../../../src/tools/define-tool.js";
import { seconds } from "../../../src/units/index.js";
import {
  BrokenJobsTool,
  FakeJobBoardService,
  JobBoardService,
  SearchJobsTool,
  SlowJobBoardService,
} from "../fixtures/units.js";

describe("testTool", () => {
  it("runs the tool on its replaced service: output, spend and the call's step", async () => {
    const runSearch = testTool(SearchJobsTool, {
      overrides: [override(JobBoardService, FakeJobBoardService)],
    });

    const { output, spend } = await runSearch({ query: "TS" });

    expect(output).toEqual({ jobs: "TS engineer\nTS lead", step: "search_jobs:test-call" });
    expect(spend.totalUsd).toBeCloseTo(0.002);
    expect(spend.byCaller).toEqual({ "tool:search_jobs": 0.002 });
  });

  it("the real service runs when nothing replaces it: its error rejects as thrown", async () => {
    const runSearch = testTool(SearchJobsTool);

    await expect(runSearch({ query: "TS" })).rejects.toThrow(
      "the real job board was called for TS",
    );
  });

  it("the call's signal aborts after its timeout on the runner's clock", async () => {
    const runSearch = testTool(SearchJobsTool, {
      overrides: [override(JobBoardService, SlowJobBoardService)],
    });

    const call = runSearch({ query: "TS" }, { timeout: seconds(1) });
    const failed = expect(call).rejects.toBeInstanceOf(ToolTimeoutError);
    await runSearch.clock.advance(seconds(1));

    await failed;
  });

  it("without a timeout the tool's own timeoutMs applies", async () => {
    const runSearch = testTool(SearchJobsTool, {
      overrides: [override(JobBoardService, SlowJobBoardService)],
    });

    const call = runSearch({ query: "TS" });
    const failed = expect(call).rejects.toThrow("timed out after 5000 ms");
    await runSearch.clock.advance(seconds(5));

    await failed;
  });

  it("an input that does not fit the input DTO is refused before the tool runs", async () => {
    const runSearch = testTool(SearchJobsTool, {
      overrides: [override(JobBoardService, FakeJobBoardService)],
    });

    // @ts-expect-error — the input is typed by the tool's input DTO; the runtime check stays
    await expect(runSearch({ query: 7 })).rejects.toBeInstanceOf(DtoValidationError);
  });

  it("an output that does not fit the output DTO fails the call", async () => {
    const runBroken = testTool(BrokenJobsTool);

    await expect(runBroken({ query: "TS" })).rejects.toBeInstanceOf(DtoValidationError);
  });

  it("a class that is no tool is a setup error", () => {
    // @ts-expect-error — a class without run(input) is no tool
    expect(() => testTool(JobBoardService)).toThrow("is not a @Tool component");
  });
});
