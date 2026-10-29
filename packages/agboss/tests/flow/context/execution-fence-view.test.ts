/**
 * #471 — the fence view on its own: a frame whose lease is yielded (or holds no token) refuses every
 * member by name, `confirmNow()` rejecting rather than throwing; `fenceOver` reads its lease at each
 * use and builds the fenced error for that lease's scope and token.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionFacts, Frame, FrameLease } from "../../../src/flow/context/frame.js";
import { fenceOver, liveFenceOf } from "../../../src/flow/context/execution-fence.js";
import { ExecutionContextUnavailableError, ExecutionFencedError } from "../../../src/index.js";

const leaseWith = (overrides: Partial<FrameLease>): FrameLease => ({
  tenantId: "acme",
  leaseExecutionId: "root-1",
  scopeKey: "acme:root-1",
  token: 3,
  confirmedUntil: 1_000,
  isYielded: false,
  assertHeld: () => undefined,
  confirmNow: () => Promise.resolve(),
  enterStep: () => Promise.resolve(() => undefined),
  ...overrides,
});

const frameWith = (lease: FrameLease) => (): Frame =>
  ({ execution: { lease } as Partial<ExecutionFacts> }) as Frame;

const SYNC_MEMBERS = [
  ["scopeKey", (fence: ReturnType<typeof liveFenceOf>) => fence.scopeKey],
  ["tenantId", (fence: ReturnType<typeof liveFenceOf>) => fence.tenantId],
  ["leaseExecutionId", (fence: ReturnType<typeof liveFenceOf>) => fence.leaseExecutionId],
  ["token", (fence: ReturnType<typeof liveFenceOf>) => fence.token],
  ["confirmedUntil", (fence: ReturnType<typeof liveFenceOf>) => fence.confirmedUntil],
  [
    "assertHeld",
    (fence: ReturnType<typeof liveFenceOf>) => {
      fence.assertHeld();
    },
  ],
  ["fenced", (fence: ReturnType<typeof liveFenceOf>) => fence.fenced(4)],
] as const;

describe.each([
  ["yielded for remote children", { isYielded: true, token: undefined }],
  ["holding no token", { token: undefined }],
])("#471: a fence whose lease is %s", (_case, overrides) => {
  const fence = liveFenceOf(frameWith(leaseWith(overrides)), "ReleaseAction");

  it.each(SYNC_MEMBERS)("refuses %s by its name", (member, read) => {
    expect(() => read(fence)).toThrow(ExecutionContextUnavailableError);
    expect(() => read(fence)).toThrow(
      `ReleaseAction read executionContext.fence.${member} while its lease is yielded for remote children.`,
    );
  });

  it("confirmNow() rejects with the same refusal, never throws synchronously", async () => {
    const confirmed = fence.confirmNow();

    await expect(confirmed).rejects.toThrow(ExecutionContextUnavailableError);
    await expect(confirmed).rejects.toThrow("executionContext.fence.confirmNow while its lease");
  });
});

describe("#471: fenceOver", () => {
  it("reads each member of the lease it is given at that moment", () => {
    let lease = leaseWith({});
    const fence = fenceOver(() => lease);
    expect([fence.scopeKey, fence.tenantId, fence.leaseExecutionId, fence.token]).toEqual([
      "acme:root-1",
      "acme",
      "root-1",
      3,
    ]);
    expect(fence.confirmedUntil).toEqual(new Date(1_000));

    lease = leaseWith({ scopeKey: "acme:root-2", token: 4, confirmedUntil: 2_000 });

    expect([fence.scopeKey, fence.token]).toEqual(["acme:root-2", 4]);
    expect(fence.confirmedUntil).toEqual(new Date(2_000));
  });

  it("a lease without a token reads as token 0, in the fenced error too", () => {
    const fence = fenceOver(() => leaseWith({ token: undefined }));

    const fenced = fence.fenced();

    expect(fence.token).toBe(0);
    expect(fenced).toBeInstanceOf(ExecutionFencedError);
    expect(fenced).toMatchObject({ scopeKey: "acme:root-1", token: 0, observedToken: undefined });
  });

  it("assertHeld() and confirmNow() are the lease's own", async () => {
    const lost = new Error("lost");
    const fence = fenceOver(() =>
      leaseWith({
        assertHeld: () => {
          throw lost;
        },
        confirmNow: () => Promise.reject(lost),
      }),
    );

    expect(() => {
      fence.assertHeld();
    }).toThrow(lost);
    await expect(fence.confirmNow()).rejects.toBe(lost);
  });

  it("is frozen: a member cannot be replaced", () => {
    const fence = fenceOver(() => leaseWith({}));

    expect(Object.isFrozen(fence)).toBe(true);
  });
});
