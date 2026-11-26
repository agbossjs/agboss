import { describe, expectTypeOf, it } from "vitest";
import type {
  App,
  DelegateResumeOptions,
  PauseActor,
  TenantContextBranded,
  PauseCallerOptions,
  ResumeOptions,
  OwnerResumeOptions,
} from "../../src/index.js";

/**
 * #942: `app.setPauseTimeout` takes the caller fields only (`PauseCallerOptions`); the call options of
 * a run — `signal`, `onStream`, `record`, `configurable` — do not compile there, as they do not on
 * `app.cancel` (the codebase rejects them by types: an object literal with an unknown field fails).
 * `app.resume` keeps every field, and its option types stay what they were.
 */

declare const app: App<TenantContextBranded<false>>;
const request = { pauseId: "p", expiresIn: 1000 } as never;

describe("#946: app.reassignPause takes PauseCallerOptions too", () => {
  const reassignment = { pauseId: "p", assignees: ["deputy-3"] } as const;

  it("the caller fields compile; the call options of a run and both credentials do not", () => {
    void app.reassignPause(reassignment, { actor: { id: "manager-17" } });
    void app.reassignPause(reassignment, { ownerId: "alice", tenantId: "acme" });
    void app.reassignPause(reassignment);
    // @ts-expect-error — `onStream` belongs to a run: reassignPause runs nothing
    void app.reassignPause(reassignment, { actor: { id: "m" }, onStream: () => undefined });
    // @ts-expect-error — a pause is answered by its owner or through its channel, not both
    void app.reassignPause(reassignment, { actor: { id: "m" }, ownerId: "alice" });
  });

  it("the request is a pause id and what moves; the answer is the pause's key and where it waits", async () => {
    // a pause id and nothing else compiles: it asks the target's `assign`
    void app.reassignPause({ pauseId: "p" });
    // @ts-expect-error — 0.1.0's one `assignee` is gone: a pool of `assignees`
    void app.reassignPause({ pauseId: "p", assignee: "d" });
    // @ts-expect-error — the wait is `timeout`, the 0.1.0 `expiresIn` is gone
    void app.reassignPause({ pauseId: "p", assignees: ["d"], expiresIn: 1000 });
    // @ts-expect-error — a target is a class, not its name
    void app.reassignPause({ pauseId: "p", target: "some-tool-approval" });
    expectTypeOf(await app.reassignPause(reassignment)).toEqualTypeOf<{
      readonly pauseKey: string;
      readonly target: string;
      readonly channel?: string;
      readonly assignees?: readonly string[];
      readonly expiresAt?: Date;
    }>();
  });
});

describe("#942: PauseCallerOptions", () => {
  it("the caller fields compile", () => {
    void app.setPauseTimeout(request, { actor: { id: "manager-17" } });
    void app.setPauseTimeout(request, { ownerId: "alice", tenantId: "acme" });
    void app.setPauseTimeout(request);
  });

  it("the call options of a run do not", () => {
    // @ts-expect-error — `onStream` belongs to a run: setPauseTimeout runs nothing
    void app.setPauseTimeout(request, { actor: { id: "m" }, onStream: () => undefined });
    // @ts-expect-error — `record` belongs to a run
    void app.setPauseTimeout(request, { ownerId: "alice", includeRecord: true });
    // @ts-expect-error — `signal` belongs to a run
    void app.setPauseTimeout(request, { actor: { id: "m" }, signal: new AbortController().signal });
  });

  it("both credentials at once do not", () => {
    // @ts-expect-error — a pause is answered by its owner or through its channel, not both
    void app.setPauseTimeout(request, { actor: { id: "m" }, ownerId: "alice" });
  });

  it("app.resume's options are unchanged: the caller fields and the call options", () => {
    expectTypeOf<OwnerResumeOptions>().toExtend<{
      onStream?: unknown;
      ownerId?: string | undefined;
    }>();
    expectTypeOf<DelegateResumeOptions>().toExtend<{
      record?: boolean | undefined;
      actor: PauseActor;
    }>();
    expectTypeOf<ResumeOptions>().toExtend<PauseCallerOptions>();
    void app.resume({ pauseId: "p", decision: {} }, { actor: { id: "m" }, includeRecord: true });
  });
});
