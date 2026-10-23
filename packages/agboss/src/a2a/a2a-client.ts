import { ComponentError, componentOf } from "../components/metadata.js";
import { z } from "zod";
import { validate } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import { A2ACallerRejectedError } from "./a2a-caller.js";
import { readEvents } from "./a2a-sse.js";
import {
  A2AResponseSchema,
  A2AStatus,
  type A2AEvent,
  type A2AExecutionRequest,
  type A2AExecutionResponse,
} from "./types.js";

/** The wire shape of a refused caller (`{ code, error }`, #387). */
const CallerRejectionSchema = z.object({
  code: z.string().startsWith("a2a.caller-"),
  error: z.string(),
});

export interface A2AClientOptions {
  /** The remote agent's base URL; default: `@A2AAgent({ url })` of the class. */
  readonly url?: string;
  readonly headers?: Record<string, string>;
  /** Pluggable fetch implementation (tests, proxies). */
  readonly fetcher?: typeof fetch;
}

/** Per call: progress events of the remote run, a signal that aborts the call, the thread to continue. */
export interface A2AClientCall {
  readonly onEvent?: (event: A2AEvent) => void;
  readonly signal?: AbortSignal;
  /** The thread to continue, in the caller's tenant on the server (#387: `threadId` on the wire). */
  readonly threadId?: string;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** A `401` / `403` whose body names an `a2a.caller-*` code: the server refused the caller. */
async function callerRejectionOf(response: Response): Promise<A2ACallerRejectedError | undefined> {
  if (response.status !== HTTP_UNAUTHORIZED && response.status !== HTTP_FORBIDDEN) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = CallerRejectionSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return new A2ACallerRejectedError(response.status, parsed.data.code, parsed.data.error);
}

/** The remote run did not answer: its status, error and the full response. */
export class A2ARemoteError extends Error {
  override name = "A2ARemoteError";
  constructor(readonly response: A2AExecutionResponse) {
    super(
      `A2A remote run ended "${response.status}"${response.error === undefined ? "" : `: ${response.error}`}`,
    );
  }
}

/** The url `@A2AAgent` recorded on the class being constructed. */
function urlOf(target: object, name: string): string {
  const meta = componentOf(target);
  if (meta?.kind !== "a2a-agent") {
    throw new ComponentError(
      `[a2a.no-url] ${name} has no @A2AAgent({ url }) and no url option — the remote agent's address is unknown`,
    );
  }
  return meta.meta.url;
}

/**
 * Calls a workflow exposed over A2A (`a2aHttpListener`). Subclass it with `@A2AAgent({ name, url,
 * deps })` and inject it like any provider; `execute(input, OutputDto)` returns the remote output
 * validated by the DTO.
 */
export class A2AClient {
  readonly url: string;

  private readonly fetcher: typeof fetch;

  private readonly headers: Record<string, string>;

  constructor(options: A2AClientOptions = {}) {
    this.url = options.url ?? urlOf(new.target, new.target.name);
    this.fetcher = options.fetcher ?? fetch;
    this.headers = options.headers ?? {};
  }

  /** Extra headers per call (e.g. a fresh token); override in a subclass. */
  protected getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  /** Runs the remote workflow and returns its output checked by `output`; any other status throws. */
  public async execute<T extends object>(
    input: unknown,
    output: DtoClass<T>,
    call: A2AClientCall = {},
  ): Promise<T> {
    const response = await this.send(input, call);
    if (response.status !== A2AStatus.Finished) throw new A2ARemoteError(response);
    return validate(output, response.output);
  }

  /**
   * Runs the remote workflow and returns its response whatever the status; a server that refuses
   * the caller (`401` / `403`) throws `A2ACallerRejectedError` (#387).
   */
  public async send(input: unknown, call: A2AClientCall = {}): Promise<A2AExecutionResponse> {
    const body: A2AExecutionRequest = {
      input,
      ...(call.threadId === undefined ? {} : { threadId: call.threadId }),
    };
    const streaming = call.onEvent !== undefined;
    const response = await this.fetcher(`${this.url}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
        ...this.headers,
        ...(await this.getHeaders()),
      },
      body: JSON.stringify(body),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
    if (!response.ok) {
      throw (
        (await callerRejectionOf(response)) ??
        new Error(`A2A request to ${this.url} failed with status ${String(response.status)}`)
      );
    }
    const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (isStream && response.body !== null) {
      return readEvents(response.body, call.onEvent);
    }
    return A2AResponseSchema.parse(await response.json());
  }
}
