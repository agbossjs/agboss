/**
 * #471 AC1 — the lease scope of a step's fence: a root and its `ParentInstance` child share the
 * root's lease, a `ChildPlacement.AnyInstance` child fences with its own; an ancestor's fence and a
 * budget's `maxSpend()` (read before the first pass) refuse with `ExecutionContextUnavailableError`.
 * `scopeKey` encodes each part, so ids with `:` neither collide nor lose their parts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { scopeKeyOf, scopeOfKey } from "../../src/app/lease-lost.js";
import { ExecutionContextUnavailableError, ExecutionFencedError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  FarParentWorkflowStart,
  FenceChildrenApplication,
  NearParentWorkflowStart,
  resetScopes,
  scopes,
} from "./fixtures/fence-children.workflow.js";

const test = testWith(FenceChildrenApplication);

beforeEach(() => {
  resetScopes();
  resetRecovery();
});

describe("#471 AC1: the scope of a step's lease", () => {
  test("a ParentInstance child fences with its root's lease; its ancestors' fences refuse", async ({
    app,
  }) => {
    const result = await execute(
      app,
      NearParentWorkflowStart,
      { text: "near" },
      { tenant: { tenantId: "acme:eu" } },
    );

    const root = scopes.fences.get("root near");
    const child = scopes.fences.get("near child");
    expect(root).toMatchObject({
      scopeKey: `acme%3Aeu:${result.executionId}`,
      tenantId: "acme:eu",
      leaseExecutionId: result.executionId,
      token: 1,
    });
    expect(child).toMatchObject({
      scopeKey: root?.scopeKey,
      leaseExecutionId: result.executionId,
      token: 1,
    });
    expect(child?.idempotencyKey).not.toBe(root?.idempotencyKey);
    expect(scopes.refusals.get("near child.parent")).toBeInstanceOf(
      ExecutionContextUnavailableError,
    );
    expect(scopes.refusals.get("near child.root")).toBeInstanceOf(ExecutionContextUnavailableError);
    expect(String(scopes.refusals.get("near child.parent"))).toMatch(
      /executionContext\.fence of an ancestor execution/,
    );
  });

  test("an AnyInstance child fences with its own lease: its own execution, token 1", async ({
    app,
  }) => {
    const result = await execute(app, FarParentWorkflowStart, { text: "far" });

    const child = scopes.fences.get("far child");
    expect(child?.leaseExecutionId).not.toBe(result.executionId);
    const leaseExecutionId = child?.leaseExecutionId ?? "";
    expect(child?.scopeKey).toBe(`default:${encodeURIComponent(leaseExecutionId)}`);
    expect(child?.token).toBe(1);
    expect(child?.idempotencyKey.startsWith(`${leaseExecutionId}:`)).toBe(true);
    expect(scopes.refusals.get("far child.parent")).toBeInstanceOf(
      ExecutionContextUnavailableError,
    );
  });

  test("a budget's maxSpend(), read before the first pass, has no fence", async ({ app }) => {
    await execute(app, NearParentWorkflowStart, { text: "near" });

    const refusal = scopes.refusals.get("maxSpend");
    expect(refusal).toBeInstanceOf(ExecutionContextUnavailableError);
    expect(String(refusal)).toMatch(/where no lease is held/);
  });
});

describe("#471: scopeKey", () => {
  it("encodes each part, joined by one ':' — no two scopes collide, each decodes back", () => {
    const one = scopeKeyOf("acme:child", "1");
    const other = scopeKeyOf("acme", "child:1");

    expect(one).toBe("acme%3Achild:1");
    expect(other).toBe("acme:child%3A1");
    expect(one).not.toBe(other);
    expect(scopeOfKey(one)).toEqual({ tenantId: "acme:child", leaseExecutionId: "1" });
    expect(scopeOfKey(other)).toEqual({ tenantId: "acme", leaseExecutionId: "child:1" });
  });

  it("keeps plain and UUID ids as they are", () => {
    const id = "7f3a91c2-0b1e-4c5d-9e8f-1a2b3c4d5e6f";

    expect(scopeKeyOf("default", id)).toBe(`default:${id}`);
    expect(scopeKeyOf("tenant-1", "execution-1")).toBe("tenant-1:execution-1");
  });

  it("refuses a text that is not a scope key", () => {
    expect(scopeOfKey("no-colon")).toBeUndefined();
    expect(scopeOfKey("a:b:c")).toBeUndefined();
    expect(scopeOfKey("%E0%A4%A:x")).toBeUndefined();
    expect(() => new ExecutionFencedError({ scopeKey: "a:b:c", token: 1 })).toThrow(
      /is not a scope key/,
    );
  });

  it("an ExecutionFencedError built from a scope key names its tenant, execution and tokens", () => {
    const error = new ExecutionFencedError({
      scopeKey: scopeKeyOf("acme:eu", "root:1"),
      token: 1,
      observedToken: 3,
    });

    expect(error).toMatchObject({
      code: "execution.lease-lost.fenced",
      tenantId: "acme:eu",
      leaseExecutionId: "root:1",
      rootExecutionId: "root:1",
      token: 1,
      observedToken: 3,
    });
    expect(error.message).toMatch(/token 1 was refused: the external system saw token 3/);
    expect(new ExecutionFencedError({ scopeKey: "a:b", token: 2 }).message).toMatch(
      /saw a newer one/,
    );
  });
});
