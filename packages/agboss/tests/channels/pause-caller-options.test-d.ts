import { describe, expectTypeOf, it } from "vitest";
import type {
  App,
  ChannelResumeOptions,
  PauseCallerOptions,
  ResumeOptions,
  ThreadOwnerResumeOptions,
} from "../../src/index.js";

/**
 * #942: `app.extendPause` takes the caller fields only (`PauseCallerOptions`); the call options of
 * a run — `signal`, `onStream`, `record`, `configurable` — do not compile there, as they do not on
 * `app.cancel` (the codebase rejects them by types: an object literal with an unknown field fails).
 * `app.resume` keeps every field, and its option types stay what they were.
 */

declare const app: App;
const request = { pauseId: "p", expiresIn: 1000 } as never;

describe("#942: PauseCallerOptions", () => {
  it("the caller fields compile", () => {
    void app.extendPause(request, { answeredBy: "manager-17" });
    void app.extendPause(request, { ownerId: "alice", tenantId: "acme" });
    void app.extendPause(request);
  });

  it("the call options of a run do not", () => {
    // @ts-expect-error — `onStream` belongs to a run: extendPause runs nothing
    void app.extendPause(request, { answeredBy: "m", onStream: () => undefined });
    // @ts-expect-error — `record` belongs to a run
    void app.extendPause(request, { ownerId: "alice", record: true });
    // @ts-expect-error — `signal` belongs to a run
    void app.extendPause(request, { answeredBy: "m", signal: new AbortController().signal });
  });

  it("both credentials at once do not", () => {
    // @ts-expect-error — a pause is answered by its owner or through its channel, not both
    void app.extendPause(request, { answeredBy: "m", ownerId: "alice" });
  });

  it("app.resume's options are unchanged: the caller fields and the call options", () => {
    expectTypeOf<ThreadOwnerResumeOptions>().toExtend<{ onStream?: unknown; ownerId?: string | undefined }>();
    expectTypeOf<ChannelResumeOptions>().toExtend<{ record?: boolean | undefined; answeredBy: string }>();
    expectTypeOf<ResumeOptions>().toExtend<PauseCallerOptions>();
    void app.resume({ pauseId: "p", decision: {} }, { answeredBy: "m", record: true });
  });
});
