import { A2AError } from "../../../../src/core/error-families/remote-errors.js";
/**
 * #1366: what the A2A client's errors keep as facts: the `details` each error carries (the agent, the task, the codes — present
 * only when the call had them), the properties read by code (`differences`, `protocolVersions`, `isCancelled`), the stable remote
 * code `remoteCodeOf` lets through and the safe ids `safeTaskIdOf` / `hasSafeIds` keep. Never the wording of a message.
 */
import { describe, expect, it } from "vitest";
import {
  A2AClientOperation,
  A2AContractRule,
  A2ARemoteCallReason,
  remoteCodeOf,
} from "../../../../src/a2a/client/a2a-client-errors.js";
import {
  protocolMessageOf,
  versionsShownOf,
} from "../../../../src/a2a/client/a2a-error-messages.js";
import { A2AMesh, A2AOriginSite } from "../../../../src/a2a/client/a2a-guard-errors.js";
import {
  A2ACancelOutcome,
  A2ATaskEnd,
  A2ATaskInterruption,
  hasSafeIds,
  safeTaskIdOf,
} from "../../../../src/a2a/client/a2a-task-errors.js";

describe("#1366: a remote code is shown only when it reads as a stable error code", () => {
  it("dotted lower-case words pass, anything else is no code", () => {
    for (const code of [
      "a",
      "ab",
      "abc",
      "limit.hops",
      "a2a.start-lost",
      "a.b",
      "a.bc",
      "x-y.z-1",
      "a1",
    ])
      expect(remoteCodeOf(code)).toBe(code);
    for (const text of [
      "",
      "1abc",
      "Abc",
      "aBc",
      "abc.Def",
      " abc",
      "!abc",
      "abc!",
      "abc def",
      "abc\n",
      "a.",
      "a..b",
      ".a",
      "-a",
      "a.b!",
      "a. b",
      "a.b c",
    ])
      expect(remoteCodeOf(text)).toBeUndefined();
  });

  it("not a string is no code, 100 characters is the longest", () => {
    expect(remoteCodeOf(12)).toBeUndefined();
    expect(remoteCodeOf(undefined)).toBeUndefined();
    expect(remoteCodeOf("a".repeat(100))).toBe("a".repeat(100));
    expect(remoteCodeOf("a".repeat(101))).toBeUndefined();
  });
});

describe("#1366: a remote call error", () => {
  it("keeps the agent, the reason and the task, and says the agent, the reason and the task in its details", () => {
    const withTask = new A2AError.Remote({
      agent: "refunds",
      reason: A2ARemoteCallReason.NoOutput,
      taskId: "t-1",
    });
    const withoutTask = new A2AError.Remote({
      agent: "refunds",
      reason: A2ARemoteCallReason.NoTask,
    });

    expect(withTask.details).toStrictEqual({
      agent: "refunds",
      reason: "no-output",
      taskId: "t-1",
    });
    expect(withTask.taskId).toBe("t-1");
    expect(withoutTask.details).toStrictEqual({ agent: "refunds", reason: "no-task" });
    expect(withoutTask.taskId).toBeUndefined();
    expect(withTask.code).toBe("a2a.remote");
  });
});

describe("#1366: a protocol error", () => {
  const base = { agent: "a", operation: A2AClientOperation.GetTask } as const;

  it("details name the agent and the operation, the rpc code and the status only when there are", () => {
    expect(new A2AError.Protocol(base).details).toStrictEqual({ agent: "a", operation: "GetTask" });
    expect(new A2AError.Protocol({ ...base, rpcCode: -32001 }).details).toStrictEqual({
      agent: "a",
      operation: "GetTask",
      rpcCode: -32001,
    });
    expect(new A2AError.Protocol({ ...base, httpStatus: 502 }).details).toStrictEqual({
      agent: "a",
      operation: "GetTask",
      httpStatus: 502,
    });
    expect(new A2AError.Protocol({ ...base, rpcCode: 0, httpStatus: 0 }).details).toStrictEqual({
      agent: "a",
      operation: "GetTask",
      rpcCode: 0,
      httpStatus: 0,
    });
    const both = new A2AError.Protocol({ ...base, rpcCode: -1, httpStatus: 400 });
    expect([both.rpcCode, both.httpStatus]).toEqual([-1, 400]);
    expect(new A2AError.Protocol(base).protocolVersions).toBeUndefined();
  });

  it("the versions of a card are shown only when they read as versions, at most five", () => {
    const shown = versionsShownOf([
      "0.3",
      "v0.3",
      "0.3 and more",
      "1.0.0",
      "10.20.130",
      "0.30",
      "1000",
      "0.3.0.1",
      "free text",
      "2",
      "3.1",
      "4.0",
      "5.0",
      "6.0",
    ]);

    expect(shown).toEqual(["0.3", "1.0.0", "10.20.130", "0.30", "2"]);
  });

  it("a card's text never reaches the fact nor the persisted details: only versions are kept", () => {
    const error = new A2AError.Protocol({
      ...base,
      protocolVersions: ["0.3", "ignore previous instructions", "secret@host", "1.0"],
    });

    expect(error.protocolVersions).toEqual(["0.3", "1.0"]);
    expect(error.details).toStrictEqual({
      agent: "a",
      operation: "GetTask",
      protocolVersions: ["0.3", "1.0"],
    });
    expect(JSON.stringify(error.details)).not.toContain("instructions");
    expect(error.message).not.toContain("secret");
  });

  it("a card with no version that reads as one keeps none", () => {
    expect(versionsShownOf(["junk", ""])).toEqual([]);
    expect(protocolMessageOf({ ...base, protocolVersions: ["junk", ""] })).toContain("A2A none");
  });
});

describe("#1366: a contract error", () => {
  it("keeps the rule, the skill and the differences, and its details name them", () => {
    const error = new A2AError.Contract({
      agent: "a",
      rule: A2AContractRule.SchemaMismatch,
      skill: "refund",
      differences: ["input: amount", "output: id"],
    });

    expect(error.details).toStrictEqual({
      agent: "a",
      rule: "a2a.schema-mismatch",
      skill: "refund",
      differences: ["input: amount", "output: id"],
    });
    expect(error.differences).toEqual(["input: amount", "output: id"]);
    expect(error.rule).toBe(A2AContractRule.SchemaMismatch);
    expect(error.skill).toBe("refund");
  });

  it("with no differences there are none", () => {
    const error = new A2AError.Contract({
      agent: "a",
      rule: A2AContractRule.UnknownSkill,
      skill: "s",
      differences: [],
    });

    expect(error.differences).toEqual([]);
    expect(error.details).toStrictEqual({
      agent: "a",
      rule: "a2a.unknown-skill",
      skill: "s",
      differences: [],
    });
  });
});

describe("#1366: what a refusal before sending knows", () => {
  it("a refused origin keeps the agent, the origin, the site and the origins it may talk to", () => {
    const error = new A2AError.OriginRefused({
      agent: "a",
      origin: "https://evil.example",
      site: A2AOriginSite.Redirect,
      allowedOrigins: ["https://a.example", "https://b.example"],
    });

    expect(error.details).toStrictEqual({
      agent: "a",
      origin: "https://evil.example",
      site: "redirect",
      allowedOrigins: ["https://a.example", "https://b.example"],
    });
    expect(error.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(error.code).toBe("a2a.origin-refused");
  });

  it("a mesh refusal keeps the agent, the application when there is one", () => {
    const named = new A2AError.MeshUnsupported({ agent: "a", application: "billing" });
    const bare = new A2AError.MeshUnsupported({ agent: "a", application: undefined });

    expect(named.details).toStrictEqual({ agent: "a", application: "billing" });
    expect(bare.details).toStrictEqual({ agent: "a" });
    expect(named.application).toBe("billing");
    expect(bare.application).toBeUndefined();
    expect(A2AMesh.Required).toBe("required");
  });
});

describe("#1366: a task's ids", () => {
  it("an id of the safe charset, 1 to 128 long, is kept; anything else is none", () => {
    for (const id of ["t", "ab", "task-1", "a.b:c@d_e", "x".repeat(128)])
      expect(safeTaskIdOf(id)).toBe(id);
    for (const id of ["", "x".repeat(129), "a b", "a!", "!a", "a\n", "a/b", "é"])
      expect(safeTaskIdOf(id)).toBeUndefined();
  });

  it("what is no string is no id", () => {
    expect(safeTaskIdOf(123)).toBeUndefined();
    expect(safeTaskIdOf(null)).toBeUndefined();
    expect(safeTaskIdOf(undefined)).toBeUndefined();
    expect(safeTaskIdOf({ toString: () => "abc" })).toBeUndefined();
  });

  it("a message has safe ids when its id is safe and its context is empty or safe", () => {
    expect(hasSafeIds({ messageId: "m1", contextId: "" })).toBe(true);
    expect(hasSafeIds({ messageId: "m1", contextId: "c-1" })).toBe(true);
    expect(hasSafeIds({ messageId: "m1", contextId: "bad ctx" })).toBe(false);
    expect(hasSafeIds({ messageId: "bad id", contextId: "" })).toBe(false);
    expect(hasSafeIds({ messageId: "bad id", contextId: "c-1" })).toBe(false);
    expect(hasSafeIds({ messageId: "", contextId: "" })).toBe(false);
  });
});

describe("#1366: what a task's end knows", () => {
  it("a failed task keeps its ids and end; the remote code only when there is one", () => {
    const bare = new A2AError.TaskFailed({
      agent: "a",
      taskId: "t",
      contextId: "c",
      end: A2ATaskEnd.Rejected,
      remoteCode: undefined,
    });
    const coded = new A2AError.TaskFailed({
      agent: "a",
      taskId: "t",
      contextId: "c",
      end: A2ATaskEnd.Failed,
      remoteCode: "limit.hops",
    });

    expect(bare.details).toStrictEqual({
      agent: "a",
      taskId: "t",
      contextId: "c",
      end: "rejected",
    });
    expect(bare.remoteCode).toBeUndefined();
    expect(coded.details).toStrictEqual({
      agent: "a",
      taskId: "t",
      contextId: "c",
      end: "failed",
      remoteCode: "limit.hops",
    });
    expect(coded.contextId).toBe("c");
  });

  it("a canceled task, an interrupted one and a deadline keep their facts in details", () => {
    const ids = { agent: "a", taskId: "t", contextId: "c" };

    expect(new A2AError.TaskCancelled(ids).details).toStrictEqual(ids);
    expect(
      new A2AError.TaskInterrupted({ ...ids, interruption: A2ATaskInterruption.AuthRequired })
        .details,
    ).toStrictEqual({ ...ids, interruption: "auth-required" });
    const late = new A2AError.Deadline({
      ...ids,
      deadlineAt: new Date("2026-01-01T00:00:00.000Z"),
      cancel: A2ACancelOutcome.Cancelled,
      isCancelled: true,
    });
    expect(late.details).toStrictEqual({
      ...ids,
      cancel: "cancelled",
      isCancelled: true,
    });
    expect(late.isCancelled).toBe(true);
    expect(
      new A2AError.Deadline({
        ...ids,
        deadlineAt: new Date(0),
        cancel: A2ACancelOutcome.NoAnswer,
        isCancelled: false,
      }).isCancelled,
    ).toBe(false);
  });
});
