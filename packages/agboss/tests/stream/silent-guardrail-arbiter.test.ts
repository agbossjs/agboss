/** #1004 AC1, with the canary: a chat-model guardrail and a chat-model arbiter are silent. */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { canaries, useCanary } from "./canary.js";
import {
  ChatArbiter,
  ChatGuardrail,
  GuardedTextAgent,
  GuardedTextStart,
  InternalKindsApplication,
  OwnerAgent,
  OwnerDto,
  OwnersStart,
} from "./internal-kinds.fixture.js";
import { deltas } from "./writer.fixture.js";

useCanary();
const test = testWith(InternalKindsApplication);

describe("#1004: a chat-model guardrail and arbiter are silent", () => {
  test("AC1: the guardrail's canary is not heard; the agent's own is, once", async ({
    app,
    mockModel,
  }) => {
    mockModel(GuardedTextAgent).thenReturn(replyWith("A fine answer."));
    mockModel(ChatGuardrail).thenReturn(decideWith({ blocks: 0.1 }));
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      GuardedTextStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(mockModel(ChatGuardrail).requests).toHaveLength(1);
    expect(canaries(events)).toBe(1);
    expect(deltas(events)).toEqual(["CANARY", "A fine answer."]);
  });

  test("AC1: the arbiter's canary is not heard (the quorum's agents answer with a tool: no text)", async ({
    app,
    mockModel,
  }) => {
    mockModel(OwnerAgent).thenReturn(
      replyWith(OwnerDto, { owner: "Ann" }),
      replyWith(OwnerDto, { owner: "Bo" }),
    );
    mockModel(ChatArbiter).thenReturnAlways(decideWith({ counts: 0.9 }));
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      OwnersStart,
      { text: "Who owns the rota?" },
      { onStream: (event) => events.push(event) },
    );

    expect(mockModel(ChatArbiter).requests.length).toBeGreaterThan(0);
    expect(events).toEqual([]);
  });
});
