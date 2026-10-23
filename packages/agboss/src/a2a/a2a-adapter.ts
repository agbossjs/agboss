import { executeUnchecked } from "../app/execute-unchecked.js";
import type { ExecutionOptions, ExecutionOutput, ThreadOwnerResumeOptions } from "../app/types.js";
import type { Class } from "../components/injection.js";
import type { A2AApp } from "./a2a-caller.js";
import { eventOf, failureResponseOf, responseOf } from "./a2a-mapping.js";
import type {
  A2AEvent,
  A2AExecutionRequest,
  A2AExecutionResponse,
  A2AResumeRequest,
} from "./types.js";

/**
 * Per call (#261): the caller's signal, the thread's owner and the execution's typed context values
 * — `tenant` (a resume uses its `tenantId`) and the declared `execution` fields; the transport takes
 * them from its authenticated caller, never from the request body.
 */
export type A2ACallOptions = Pick<ExecutionOptions, "signal" | "ownerId" | "tenant" | "execution">;

/** What a resume takes of the call's options: the keys only — its values come from the checkpoint. */
const resumeOptionsOf = (options: A2ACallOptions): ThreadOwnerResumeOptions => ({
  signal: options.signal,
  ownerId: options.ownerId,
  tenantId: options.tenant?.tenantId,
});

/**
 * The inbound A2A boundary: a transport (`a2aHttpListener`, a framework's route) depends on this,
 * not on the app.
 */
export interface IA2AAdapter {
  execute(
    start: Class,
    req: A2AExecutionRequest,
    onEvent?: (event: A2AEvent) => void,
    options?: A2ACallOptions,
  ): Promise<A2AExecutionResponse>;

  /** `app.resume({ pauseId, decision })`: answers one pause, as the call's owner. */
  resume(
    req: A2AResumeRequest,
    onEvent?: (event: A2AEvent) => void,
    options?: A2ACallOptions,
  ): Promise<A2AExecutionResponse>;

  /**
   * `app.cancel(threadId, { tenantId, ownerId })` for the caller (#387): stops the run in flight of
   * the caller's tenant's thread (→ `cancelled`) or drops its pause; another tenant's thread of the
   * same id is never touched.
   */
  cancel(threadId: string, caller: A2ACallOptions): Promise<void>;
}

/**
 * Exposes an app's workflow over A2A: a request runs the workflow start, the response carries the
 * reply, the finish output and the final status; failures are statuses, not thrown errors.
 */
export class A2AAdapter implements IA2AAdapter {
  constructor(private readonly app: A2AApp) {}

  public execute(
    start: Class,
    req: A2AExecutionRequest,
    onEvent?: (event: A2AEvent) => void,
    options: A2ACallOptions = {},
  ): Promise<A2AExecutionResponse> {
    return this.run(req.threadId, options, (call) =>
      // the payload comes off the wire: the app checks it against the start's input
      executeUnchecked(this.app, start, req.input, {
        ...call,
        ...(req.threadId === undefined ? {} : { threadId: req.threadId }),
        ...streamTo(onEvent),
      }),
    );
  }

  public resume(
    req: A2AResumeRequest,
    onEvent?: (event: A2AEvent) => void,
    options: A2ACallOptions = {},
  ): Promise<A2AExecutionResponse> {
    const request = { pauseId: req.pauseId, decision: req.decision };
    return this.run(undefined, options, (call) =>
      this.app.resume(request, { ...resumeOptionsOf(call), ...streamTo(onEvent) }),
    );
  }

  public async cancel(threadId: string, caller: A2ACallOptions): Promise<void> {
    await this.app.cancel(threadId, { tenantId: caller.tenant?.tenantId, ownerId: caller.ownerId });
  }

  /** Runs one call, mapped to a response: a failure is a status (cancelled, limited, failed). */
  private async run(
    threadId: string | undefined,
    options: A2ACallOptions,
    call: (options: A2ACallOptions) => Promise<ExecutionOutput>,
  ): Promise<A2AExecutionResponse> {
    try {
      return responseOf(await call(options));
    } catch (error) {
      return failureResponseOf(error, options.signal, threadId);
    }
  }
}

const streamTo = (
  onEvent: ((event: A2AEvent) => void) | undefined,
): Pick<ExecutionOptions, "onStream"> =>
  onEvent === undefined
    ? {}
    : {
        onStream: (event) => {
          onEvent(eventOf(event));
        },
      };
