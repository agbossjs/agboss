import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDiagnostic } from "../../../src/core/diagnostics/render-diagnostic.js";
import { captureCallSite } from "../../../src/core/diagnostics/source-span.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { stepSpanOf } from "../../../src/flow/step-spans.js";
import { diagnosticOfViolation } from "../../../src/graph/rule-diagnostic.js";
import { onStart } from "../../flow/fixtures/paths.js";
import {
  CandidateProfileDto,
  JobListDto,
  JobPickDto,
  JobScoresDto,
} from "../../flow/fixtures/review-dtos.js";
import { inline } from "../../../src/index.js";

/** #1325c: spans of decorator calls and flow builder steps, and a broken rule drawn over them. */

const THIS = new URL(import.meta.url).pathname;
const LINES = readFileSync(THIS, "utf8").split("\n");

/** The 1-based line of the first line of this file that contains `text` and whose number is after `from`. */
const lineOf = (text: string, from = 0): number =>
  LINES.findIndex((line, index) => index >= from && line.includes(text)) + 1;

@WorkflowStart({ name: "span-start", description: "A candidate", input: CandidateProfileDto })
class SpanStart {}

@Agent({
  name: "span-search-agent",
  description: "Finds jobs for the profile",
  prompt: inline("Find jobs."),
  model: "moonshotai/kimi-k2.6",
  input: { profile: CandidateProfileDto },
  output: JobListDto,
})
class SpanSearchAgent {}

@Agent({
  name: "span-scoring-agent",
  description: "Scores the jobs",
  prompt: inline("Score them."),
  model: "moonshotai/kimi-k2.6",
  input: { jobs: JobListDto },
  output: JobScoresDto,
})
class SpanScoringAgent {}

@Agent({
  name: "span-editor-agent",
  description: "Corrects the profile",
  prompt: inline("Correct it."),
  model: "moonshotai/kimi-k2.6",
  input: { profile: CandidateProfileDto },
  output: CandidateProfileDto,
})
class SpanEditorAgent {}

@Agent({
  name: "span-picker-agent",
  description: "Picks the job",
  prompt: inline("Pick one."),
  model: "moonshotai/kimi-k2.6",
  input: { scores: JobScoresDto, profile: CandidateProfileDto },
  output: JobPickDto,
})
class SpanPickerAgent {}

@WorkflowFinish({ name: "span-finish", description: "The pick", output: JobPickDto })
class SpanFinish {}

const searchStep = onStart(SpanStart).toAgent(SpanSearchAgent);

@Workflow({
  name: "span-stale-workflow",
  version: "1.0.0",
  flow: [
    onStart(SpanStart)
      .toAgent(SpanSearchAgent)
      .toAgent(SpanScoringAgent)
      .toAgent(SpanEditorAgent)
      .toAgent(SpanPickerAgent)
      .toFinish(SpanFinish),
  ],
})
class SpanStaleWorkflow {}

describe("call sites", () => {
  it("captureCallSite names the user's file, line and column, not the framework's", () => {
    const span = captureCallSite();

    expect(span).toEqual({
      file: THIS,
      line: lineOf("const span = captureCallSite();"),
      column: expect.any(Number) as number,
    });
  });

  it("a decorator's span is its call in the user's file", () => {
    const span = declarationOf(SpanSearchAgent)?.span;

    expect(span?.file).toBe(THIS);
    expect(span?.line).toBe(lineOf("@Agent({", lineOf("class SpanStart")));
  });

  it("a builder step's span is the call of the step", () => {
    const [step] = searchStep.steps;

    expect(step === undefined ? undefined : stepSpanOf(step)).toMatchObject({
      file: THIS,
      line: lineOf("const searchStep"),
    });
  });

  it("each step of a chain has its own line", () => {
    const built = onStart(SpanStart)
      .toAgent(SpanSearchAgent)
      .toAgent(SpanScoringAgent)
      .toFinish(SpanFinish);

    const lines = built.steps.map((step) => stepSpanOf(step)?.line);
    const first = lines[0];

    expect(first).toBe(lineOf(".toAgent(SpanSearchAgent)", lineOf('it("each step of a chain')));
    expect(lines).toEqual([first, (first ?? 0) + 1, (first ?? 0) + 2]);
  });
});

describe("a broken rule drawn over the user's source", () => {
  it("[input.outdated-on-path] underlines the step that reads the outdated value", () => {
    const [violation] = checkWorkflow(SpanStaleWorkflow as never).errors.filter(
      (found) => found.code === "input.outdated-on-path",
    );
    if (violation === undefined) throw new Error("the flow must break the rule");

    const diagnostic = diagnosticOfViolation(violation);
    const text = renderDiagnostic(diagnostic, { cwd: process.cwd(), explainHint: true });

    expect(diagnostic.primary?.span).toMatchObject({
      file: THIS,
      line: lineOf(".toAgent(SpanPickerAgent)"),
    });
    expect(text).toContain(
      `${String(lineOf(".toAgent(SpanPickerAgent)"))} |       .toAgent(SpanPickerAgent)`,
    );
    expect(text).toMatch(/\^+ `span-picker-agent` breaks this rule/u);
    expect(text).toContain("= note: ");
    expect(text).toContain(
      "For more information about this error, try `agboss explain input.outdated-on-path`.",
    );
  });

  it("names a node whose place is not known in the message only", () => {
    const diagnostic = diagnosticOfViolation({
      code: "graph.dead-end",
      message: "a path stops\nat nothing",
      nodes: ["no-such-agent"],
    });

    expect(diagnostic).toMatchObject({
      code: "graph.dead-end",
      message: "a path stops",
      secondary: [],
    });
    expect(diagnostic.primary).toBeUndefined();
  });
});
