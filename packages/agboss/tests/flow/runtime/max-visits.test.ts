import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { LimitExceededError, VisitsLimitExceededError } from "../../../src/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  DoneFinish,
  DraftDto,
  EditorAgent,
  EditStart,
  GateRouter,
  GaveUpFinish,
  PatientEditorAgent,
  PatientGateRouter,
  EditApplication,
  PatientEditApplication,
} from "./fixtures/edit.workflow.js";

const edit = testWith(EditApplication);
const patient = testWith(PatientEditApplication);

const drafts = (...texts: string[]) => texts.map((text) => replyWith(DraftDto, { text }));

describe("#272 AC14: a visit past maxVisits fails before the node runs", () => {
  edit(
    "visit past maxVisits fails before the call: the third edit is refused",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturnAlways(routeTo(EditorAgent));
      // the third visit is refused before its call: two drafts are all the editor writes
      mockLlm(EditorAgent).thenReturn(...drafts("v1", "v2"));

      const run = execute(app, EditStart, { text: "a poem" });

      await expect(run).rejects.toBeInstanceOf(VisitsLimitExceededError);
      const error = (await run.catch((caught: unknown) => caught)) as VisitsLimitExceededError;
      expect(error).toBeInstanceOf(LimitExceededError);
      expect(error).toMatchObject({
        code: "limit.visits",
        component: { name: "editor-agent" },
        nodeId: "editor-agent",
        maxVisits: 2,
        visits: 3,
      });
      expect(error.message).toContain("editor-agent was visited 3 times; its maxVisits is 2");
      expect(mockLlm(EditorAgent).requests).toHaveLength(2);
      expect(mockLlm(GateRouter).requests).toHaveLength(2);
    },
  );

  edit(
    "within its visits the loop finishes; the gate reads the latest draft",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturn(routeTo(EditorAgent), routeTo(DoneFinish));
      mockLlm(EditorAgent).thenReturn(...drafts("v1", "v2"));

      const result = await execute(app, EditStart, { text: "a poem" });

      expect(result).toFollowPath([
        EditStart,
        EditorAgent,
        GateRouter,
        EditorAgent,
        GateRouter,
        DoneFinish,
      ]);
      expect(result).toFinishWith(DoneFinish, { text: "v2" });
      expect(mockLlm(GateRouter).lastRequest.input).toContain('"text": "v2"');
      expect(mockLlm(EditorAgent).lastRequest.input).toContain('"text": "v1"');
    },
  );

  patient(
    "caught by .onError(VisitsLimitExceededError, …) right after the step",
    async ({ app, mockLlm }) => {
      mockLlm(PatientGateRouter).thenReturnAlways(routeTo(PatientEditorAgent));
      mockLlm(PatientEditorAgent).thenReturn(...drafts("v1", "v2"));

      const result = await execute(app, EditStart, { text: "a poem" }, { record: true });

      expect(result.status).toBe(ExecutionStatus.Finished);
      expect(result).toFinishWith(GaveUpFinish, { text: "v2" });
      expect(result.path.slice(-2)).toEqual(["patient-editor-agent", "gave-up-workflow-finish"]);
      expect(result.record?.lastError).toMatchObject({ code: "limit.visits" });
    },
  );
});
