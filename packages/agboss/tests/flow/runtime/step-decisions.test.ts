/**
 * #401 PR 5 (S2 Q4) — what each visit decided, on its `record.steps` entry: a router's route, a
 * `oneOf` answer's class, else a hash of its value — the same for the same decision every time, so
 * the Mesh Hub's radar can count how often one input gets one decision.
 */
import { describe, expect, it } from "vitest";
import { nameOf } from "../../../src/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { decisionOf } from "../../../src/flow/runtime/visit-step.js";
import { execute } from "../../helpers/flow.js";
import {
  DoneFinish,
  DraftDto,
  EditApplication,
  EditorAgent,
  EditStart,
  GateRouter,
} from "./fixtures/edit.workflow.js";
import { TicketStart, TriageApplication } from "./fixtures/triage.workflow.js";

const HASHED = /^answer:[0-9a-f]{64}$/u;

describe("#401 PR 5: record.steps[].decision", () => {
  testWith(EditApplication)(
    "a router's route, an agent's answer by its hash — one answer, one hash; a finish decides nothing",
    async ({ app, mockLlm }) => {
      // the editor writes first, the gate sends it back once, then stops
      mockLlm(GateRouter).thenReturn(routeTo(EditorAgent), routeTo(DoneFinish));
      mockLlm(EditorAgent).thenReturn(
        replyWith(DraftDto, { text: "v1" }),
        replyWith(DraftDto, { text: "v1" }),
      );

      const result = await execute(app, EditStart, { text: "a poem" }, { record: true });

      const decisions = (result.record?.steps ?? []).map((step) => [
        step.step.nodeId,
        step.decision,
      ]);
      const routes = decisions
        .filter(([node]) => node === "gate-router")
        .map(([, decision]) => decision);
      expect(routes).toEqual(["route:editor-agent", `route:${nameOf(DoneFinish)}`]);
      const answers = decisions
        .filter(([node]) => node === "editor-agent")
        .map(([, decision]) => decision);
      expect(answers).toHaveLength(2);
      expect(answers[0]).toMatch(HASHED);
      expect(answers[1]).toBe(answers[0]);
      expect(decisions.find(([node]) => node === nameOf(DoneFinish))?.[1]).toBeUndefined();
    },
  );

  testWith(TriageApplication)("a oneOf answer by its class", async ({ app }) => {
    const result = await execute(
      app,
      TicketStart,
      { text: "it crashes", kind: "bug" },
      { record: true },
    );

    const classify = result.record?.steps.find((step) => step.step.nodeId === "classify-action");
    expect(classify?.decision).toBe("variant:BugDto");
  });

  it("a launch by its routes, sorted; a visit that gave nothing decides nothing", () => {
    expect(decisionOf({ launch: ["refund-agent", "order-agent"] })).toBe(
      "launch:order-agent,refund-agent",
    );
    expect(decisionOf({})).toBeUndefined();
    expect(decisionOf(undefined)).toBeUndefined();
    expect(decisionOf({ value: { value: undefined } })).toMatch(HASHED);
  });
});
