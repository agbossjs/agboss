import { executeUnchecked } from "../app/execute-unchecked.js";
import type { App, ExecutionOptions, ExecutionOutput } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { eventOf, failureResponseOf, responseOf } from "./a2a-mapping.js";
import type {
  A2AEvent,
  A2AExecutionRequest,
  A2AExecutionResponse,
  A2AResumeRequest,
} from "./types.js";

/** Per call: the caller's signal and the execution context the app passes to tools. */
export type A2ACallOptions = Pick<ExecutionOptions, "signal" | "executionContext">;

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

  resume(
    thread: string,
    req: A2AResumeRequest,
    onEvent?: (event: A2AEvent) => void,
    options?: A2ACallOptions,
  ): Promise<A2AExecutionResponse>;

  /** `app.cancel(thread)`: stops the thread's run in flight (→ `cancelled`) or drops its pause. */
  cancel(thread: string): Promise<void>;
}

/**
 * Exposes an app's workflow over A2A: a request runs the workflow start, the response carries the
 * reply, the finish output and the final status; failures are statuses, not thrown errors.
 */
export class A2AAdapter implements IA2AAdapter {
  constructor(private readonly app: App) {}

  public execute(
    start: Class,
    req: A2AExecutionRequest,
    onEvent?: (event: A2AEvent) => void,
    options: A2ACallOptions = {},
  ): Promise<A2AExecutionResponse> {
    return this.run(req.thread, options, (call) =>
      // the payload comes off the wire: the app checks it against the start's input
      executeUnchecked(this.app, start, req.input, {
        ...call,
        ...(req.thread === undefined ? {} : { threadId: req.thread }),
        ...streamTo(onEvent),
      }),
    );
  }

  public resume(
    thread: string,
    req: A2AResumeRequest,
    onEvent?: (event: A2AEvent) => void,
    options: A2ACallOptions = {},
  ): Promise<A2AExecutionResponse> {
    return this.run(thread, options, (call) =>
      this.app.resume(thread, req.decision, { ...call, ...streamTo(onEvent) }),
    );
  }

  public async cancel(thread: string): Promise<void> {
    await this.app.cancel(thread);
  }

  /** Runs one call, mapped to a response: a failure is a status (cancelled, limited, failed). */
  private async run(
    thread: string | undefined,
    options: A2ACallOptions,
    call: (options: A2ACallOptions) => Promise<ExecutionOutput>,
  ): Promise<A2AExecutionResponse> {
    try {
      return responseOf(await call(options));
    } catch (error) {
      return failureResponseOf(error, options.signal, thread);
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
