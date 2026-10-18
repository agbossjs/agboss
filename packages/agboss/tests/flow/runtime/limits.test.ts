import { describe, expect } from "vitest";
import { BudgetExceededError, LimitExceededError } from "../../../src/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  DoneFinish,
  DraftDto,
  EditorAgent,
  EditStart,
  GateRouter,
  CheapEditApplication,
  ShortEditApplication,
} from "./fixtures/edit.workflow.js";

const short = testWith(ShortEditApplication);
const cheap = testWith(CheapEditApplication);

const draft = (text: string, cost = 0) => replyWith(DraftDto, { text }, { cost: usd(cost) });

describe("the execution's limits are checked before a working node runs (QUALITY → FinOps)", () => {
  short(
    "maxSteps: the visit after the last allowed step fails, naming the key and the path",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturnAlways(routeTo(EditorAgent));
      mockLlm(EditorAgent).thenReturn(draft("v1"), draft("v2"));

      const run = execute(app, EditStart, { text: "a poem" });

      await expect(run).rejects.toBeInstanceOf(LimitExceededError);
      await expect(run).rejects.toMatchObject({
        key: "maxSteps",
        limit: 3,
        actual: 4,
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

  cheap(
    "limits.perRun.cost: once the run spent it, the next working node fails",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturnAlways(routeTo(EditorAgent));
      mockLlm(EditorAgent).thenReturn(draft("v1", 0.02));

      const run = execute(app, EditStart, { text: "a poem" });

      await expect(run).rejects.toFailWith({ code: "limits.perRun.cost" });
      await expect(run).rejects.toThrow("spent $0.0200");
      expect(mockLlm(GateRouter).requests).toHaveLength(0);
    },
  );

  cheap(
    "limits.perDay.cost: the day's spend stops a run, then the next one before any call",
    async ({ app, mockLlm }) => {
      mockLlm(GateRouter).thenReturnAlways(routeTo(DoneFinish));
      mockLlm(EditorAgent).thenReturn(draft("v1", 0.012), draft("v2", 0.012), draft("v3"));

      await execute(app, EditStart, { text: "one" });
      const second = execute(app, EditStart, { text: "two" });
      await expect(second).rejects.toFailWith({ code: "limits.perDay.cost" });
      const third = execute(app, EditStart, { text: "three" });

      await expect(third).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(third).rejects.toFailWith({ code: "limits.perDay.cost" });
      expect(mockLlm(EditorAgent).requests).toHaveLength(2);
    },
  );
});
