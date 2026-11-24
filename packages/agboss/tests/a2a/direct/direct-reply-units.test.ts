/**
 * #860 (mutation shard `a2a-direct`): a direct message on its own — accepted in flight for
 * `IN_FLIGHT` under a minted attempt and answered with a `Message` built from its kept row; a resend
 * of a completed one gets that row; a row another call saved first is read (the attempt's files
 * dropped), of other content `-32602`; an expired attempt of other content is not taken over; five
 * rounds that move nothing are `-32603`; the input, the mesh limit and the ids checked in order.
 */
import { Role, type Message, type Part } from "@a2a-js/sdk";
import { describe, expect, it, vi } from "vitest";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { directReply } from "../../../src/a2a/server/a2a-direct-reply.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { dataPart, textPart } from "../../../src/a2a/server/a2a-task-view.js";
import type { MeshEnvelope } from "../../../src/mesh/mesh-envelope.js";
import { seconds } from "../../../src/units/index.js";
import {
  callerOf,
  messageOf,
  NINE,
  NO_MESH,
  refusalOf,
  settle,
} from "../server/support/unit-parts.js";
import {
  acceptedMessage,
  DIRECT_SKILL,
  directRig,
  gate,
  inFlight,
  KEY,
  OUTPUT,
} from "./support/direct-parts.js";

const hello = (contextId = "ctx-7") => messageOf("m-1", ["hello"], { contextId });
const helloHash = requestHashOf(DIRECT_SKILL.id, hello());
const REPLY = { finish: "unit-workflow-finish", output: { total: 9 }, spentUsd: 0 };

describe("#860: a new direct message", () => {
  it("is kept in flight for 30 s under its attempt while it runs, then answered with its reply as a Message", async () => {
    const rig = directRig();
    const held = gate();
    const script = rig.script;
    rig.script = async (run) => {
      await held.opened;
      return script(run);
    };

    const answer = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await settle();
    const running = await rig.messages.findByKey(KEY);
    held.open();

    expect(running).toMatchObject({
      attemptId: "attempt-1",
      state: "in-flight",
      contextId: "ctx-7",
      startedAt: NINE,
      createdAt: NINE,
      expiresAt: new Date(NINE.getTime() + seconds(30)),
    });
    expect(await answer).toEqual({
      messageId: "attempt-1:reply",
      contextId: "ctx-7",
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [dataPart(OUTPUT)],
      metadata: { [A2A_SKILLS_EXTENSION]: { finish: "unit-workflow-finish" } },
      extensions: [],
      referenceTaskIds: [],
    });
  });

  it("that leaves its context empty runs on a minted thread", async () => {
    const rig = directRig();

    const answer = await directReply(rig.parts, callerOf(), hello(""), DIRECT_SKILL);

    expect([answer.contextId, rig.runs[0]?.options.threadId]).toEqual(["thread-1", "thread-1"]);
  });

  it("resent once completed gets the kept reply; the skill runs once", async () => {
    const rig = directRig();

    const first = await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    const again = await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);

    expect(again).toEqual(first);
    expect(rig.runs).toHaveLength(1);
  });

  it("resent with other content is -32602 a2a.message-id-reused, nothing run again", async () => {
    const rig = directRig();
    await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);

    const other = directReply(rig.parts, callerOf(), messageOf("m-1", ["bye"]), DIRECT_SKILL);

    expect(await refusalOf(other)).toBe(
      "RequestMalformedError a2a.message-id-reused: messageId reused with different content",
    );
    expect(rig.runs).toHaveLength(1);
  });

  it("an expired attempt of other content is not taken over: -32602, nothing run", async () => {
    const rig = directRig();
    await rig.messages.saveIfAbsent(acceptedMessage({ expiresAt: NINE }));

    const refusal = await refusalOf(directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL));

    expect(refusal).toMatch(/a2a\.message-id-reused/);
    expect(rig.runs).toHaveLength(0);
    expect((await rig.messages.findByKey(KEY))?.attemptId).toBe("run-lost");
  });
});

describe("#860: a message another call saved first", () => {
  async function savedFirst(requestHash: string) {
    const rig = directRig();
    await rig.messages.saveIfAbsent(acceptedMessage({ requestHash }));
    await rig.messages.completeIfInFlight(KEY, "run-lost", REPLY, NINE);
    // the race: this call read no row, the other saved it before this one
    vi.spyOn(rig.messages, "findByKey").mockResolvedValueOnce(undefined);
    const dropped = vi.spyOn(rig.parts.files.store, "deleteByOwner");
    return { rig, dropped };
  }

  it("of the same content: its kept reply, the attempt's files dropped, nothing run", async () => {
    const { rig, dropped } = await savedFirst(helloHash);

    const answer = await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);

    expect(answer.messageId).toBe("run-lost:reply");
    expect(dropped.mock.calls).toEqual([[{ tenantId: "acme", ownerId: "attempt-1" }]]);
    expect(rig.runs).toHaveLength(0);
  });

  it("of other content: -32602 a2a.message-id-reused, its reply not shown", async () => {
    const { rig } = await savedFirst("h-other");

    const refusal = await refusalOf(directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL));

    expect(refusal).toMatch(/a2a\.message-id-reused/);
  });
});

describe("#860: rounds that move nothing", () => {
  it("five rounds, each finding an expired attempt it cannot take over: -32603", async () => {
    const rig = directRig();
    const lost = inFlight(acceptedMessage({ requestHash: helloHash, expiresAt: NINE }));
    vi.spyOn(rig.messages, "findByKey").mockResolvedValue(lost);
    const retakes = vi.spyOn(rig.messages, "retakeIfExpired");

    const refusal = await refusalOf(directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL));

    expect(refusal).toBe("A2AInternalError: the request failed");
    expect(retakes).toHaveBeenCalledTimes(5);
    expect(rig.runs).toHaveLength(0);
  });
});

describe("#860: what a direct message is checked for, in order", () => {
  it("a context or a message id that is no key's text is -32602, naming the field", async () => {
    const rig = directRig();
    const send = (message: ReturnType<typeof hello>) =>
      refusalOf(directReply(rig.parts, callerOf(), message, DIRECT_SKILL));

    expect(await send(hello("c\uD800"))).toBe(
      "RequestMalformedError a2a.invalid-id: contextId is not a valid id",
    );
    expect(await send(messageOf("m\uD800", ["x"]))).toBe(
      "RequestMalformedError a2a.invalid-id: messageId is not a valid id",
    );
  });

  it("an input the skill refuses is refused before the message id is read", async () => {
    const rig = directRig();

    const refusal = await refusalOf(
      directReply(rig.parts, callerOf(), messageOf("m\uD800", [], { data: 1 }), DIRECT_SKILL),
    );

    expect(refusal).toBe(
      "RequestMalformedError dto.invalid: the input does not fit the skill's input",
    );
    expect(rig.runs).toHaveLength(0);
  });

  it("a message with files has its ids read before its files: a file of other bytes is not read first", async () => {
    const rig = directRig();
    const skill = {
      ...DIRECT_SKILL,
      inputFiles: [{ name: "file", isList: false, isOptional: false }],
    };
    const png: Part = {
      content: { $case: "raw", value: Buffer.from("not a png") },
      metadata: undefined,
      filename: "",
      mediaType: "image/png",
    };
    const fileOnly = { ...messageOf("m\uD800", []), parts: [png] };
    const textAndFile = { ...messageOf("m\uD800", ["see"]), parts: [textPart("see"), png] };
    const send = (message: Message) =>
      refusalOf(directReply(rig.parts, callerOf(), message, skill));

    expect([await send(fileOnly), await send(textAndFile)]).toEqual([
      "RequestMalformedError a2a.invalid-id: messageId is not a valid id",
      "RequestMalformedError a2a.invalid-id: messageId is not a valid id",
    ]);
  });

  it("a chain through the skill is refused with its mesh code before anything is kept", async () => {
    const rig = directRig();
    const envelope: MeshEnvelope = {
      schema: 1,
      issuer: "caller-application",
      origin: {
        rootExecutionId: "caller-root",
        executionId: "caller-root",
        workflow: { name: "caller-workflow", version: "1.0.0" },
        step: { component: "caller-agent", idempotencyKey: "caller-root:caller-agent:1" },
      },
      callChain: [
        { application: "unit-application", executionId: "unit-root", start: DIRECT_SKILL.id },
      ],
    };
    const caller = callerOf({ mesh: { ...NO_MESH, envelope } });

    const refusal = await refusalOf(directReply(rig.parts, caller, hello(), DIRECT_SKILL));

    expect(refusal).toBe(
      "RequestMalformedError limit.mesh-loop: the message was rejected: limit.mesh-loop",
    );
    expect(await rig.messages.findByKey(KEY)).toBeUndefined();
  });
});
