import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect } from "vitest";
import {
  callTool,
  replyWith,
  replyWithInvalidAnswer,
  routeTo,
  testWith,
} from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  DoneFinish,
  DraftDto,
  EditorAgent,
  EditStart,
  GateRouter,
  EditApplication,
} from "./fixtures/edit.workflow.js";
import {
  ChatStart,
  MainRouter,
  OrderStatus,
  Reply,
  Support,
  DeskApplication,
} from "../../testing/fixtures/desk.workflow.js";

const edit = testWith(EditApplication);
const desk = testWith(DeskApplication);

/** An answer-tool call whose arguments do not fit its DTO. */
const invalid = replyWithInvalidAnswer(DraftDto, { body: "no text field" });

describe("#272 S6 / S9: an agent with output answers through its answer tool", () => {
  edit(
    "AC1: a valid answer is the step's value: the next node reads it",
    async ({ app, mockModel }) => {
      mockModel(EditorAgent).thenReturn(replyWith(DraftDto, { text: "v1" }));
      mockModel(GateRouter).thenReturn(routeTo(DoneFinish));

      const result = await execute(app, EditStart, { text: "a poem" });

      expect(result).toFinishWith(DoneFinish, { text: "v1" });
      const request = mockModel(EditorAgent).onlyRequest;
      expect(request.kind === "chat" && request.tools.map((tool) => tool.function.name)).toEqual([
        "answer-draft-dto",
      ]);
    },
  );

  edit(
    "AC2: an invalid answer goes back to the model with the reason; the retry counts",
    async ({ app, mockModel }) => {
      mockModel(EditorAgent).thenReturn(invalid, replyWith(DraftDto, { text: "v1" }));
      mockModel(GateRouter).thenReturn(routeTo(DoneFinish));

      const result = await execute(app, EditStart, { text: "a poem" });

      expect(result).toFinishWith(DoneFinish, { text: "v1" });
      const retry = mockModel(EditorAgent).lastRequest;
      expect(JSON.stringify(retry)).toContain("text");
      expect(mockModel(EditorAgent).requests).toHaveLength(2);
    },
  );

  edit(
    "S9: after 2 retries the step fails with StepError.AgentAnswerInvalid",
    async ({ app, mockModel }) => {
      mockModel(EditorAgent).thenReturn(invalid, invalid, invalid);

      const run = execute(app, EditStart, { text: "a poem" });

      await expect(run).rejects.toBeInstanceOf(StepError.AgentAnswerInvalid);
      await expect(run).rejects.toFailWith(StepError.AgentAnswerInvalid, {
        code: "step.agent.invalid-answer",
      });
      expect(mockModel(EditorAgent).requests).toHaveLength(3);
    },
  );
});

describe("#270 Q51 / #272 AC9: the static part of a request comes first, in a canonical order", () => {
  desk(
    "tools sorted by name; the system prompt is the same on every call",
    async ({ app, mockModel }) => {
      mockModel(MainRouter).thenReturn(routeTo(Support));
      mockModel(Support).thenReturn(callTool(OrderStatus, { orderId: "1" }), replyWith("Shipped."));

      const result = await execute(app, ChatStart, { text: "where is 1?" });

      expect(result).toFinishWith(Reply, { text: "Shipped." });
      const [first, second] = mockModel(Support).requests;
      if (first?.kind !== "chat" || second?.kind !== "chat")
        throw new Error("chat requests expected");
      const names = first.tools.map((tool) => tool.function.name);
      expect(names).toEqual([...names].sort());
      expect(names).toEqual(["order-status-tool", "read-note-tool", "save-note-tool"]);
      expect(second.system).toBe(first.system);
      expect(second.tools).toEqual(first.tools);
    },
  );
});
