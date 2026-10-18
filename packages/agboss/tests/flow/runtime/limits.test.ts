import { describe, expect } from "vitest";
import { LimitExceededError, StepsLimitExceededError } from "../../../src/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  DoneFinish,
  DraftDto,
  EditorAgent,
  EditStart,
  GateRouter,
  ShortEditApplication,
} from "./fixtures/edit.workflow.js";

const short = testWith(ShortEditApplication);

const draft = (text: string) => replyWith(DraftDto, { text });

describe("the execution's steps are checked before a working node runs (QUALITY → FinOps)", () => {
  short(
    "maxSteps: the visit after the last allowed step fails with StepsLimitExceededError",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturnAlways(routeTo(EditorAgent));
      mockLlm(EditorAgent).thenReturn(draft("v1"), draft("v2"));

      const run = execute(app, EditStart, { text: "a poem" });

      await expect(run).rejects.toBeInstanceOf(StepsLimitExceededError);
      await expect(run).rejects.toBeInstanceOf(LimitExceededError);
      await expect(run).rejects.toThrow("short-edit-workflow took 4 steps; its maxSteps is 3");
      await expect(run).rejects.toMatchObject({
        code: "limit.steps",
        workflow: { name: "short-edit-workflow", version: "1.0.0", startedVersion: "1.0.0" },
        maxSteps: 3,
        steps: 4,
        path: ["edit-workflow-start", "editor-agent", "gate-router", "editor-agent", "gate-router"],
      });
      expect(mockLlm(GateRouter).requests).toHaveLength(1);
    },
  );

  short("an execution within its steps finishes", async ({ app, mockLlm }) => {
    mockLlm(GateRouter).thenReturn(routeTo(DoneFinish));
    mockLlm(EditorAgent).thenReturn(draft("v1"));

    await expect(execute(app, EditStart, { text: "a poem" })).resolves.toFinishWith(DoneFinish);
  });
});
