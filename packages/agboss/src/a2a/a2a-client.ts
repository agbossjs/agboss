import { ComponentError, componentOf } from "../components/metadata.js";
import { z } from "zod";
import { validate } from "../dto/schema.js";
import { A2ACallerRejectedError } from "./a2a-caller.js";
import { readEvents } from "./a2a-sse.js";
import { outboundMeshOf, type OutboundMesh } from "../mesh/outbound-mesh.js";
import { takeRunReport, type ContractPrice } from "../mesh/mesh-report.js";
import type { A2AContract } from "./a2a-contract.js";
import { meshHeadersOf, meshRefusalOfResponse } from "./a2a-client-mesh.js";
import { meshLimitErrorOf } from "../mesh/mesh-wire.js";
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
  /**
   * The contract of a client built without `@A2AAgent` (a script, a test): what `execute` takes
   * and gives, its target and price — default: the class's `@A2AAgent`.
   */
  readonly contract?: A2AContract;
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
  // read from a copy: a refusal that is not the caller's is read again (a refused envelope, #398)
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
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

/** The body of `POST <url>/execute`: the input, the exported start it names, the thread. */
const requestOf = (
  input: unknown,
  start: string | undefined,
  threadId: string | undefined,
): A2AExecutionRequest => ({
  input,
  ...(start === undefined ? {} : { start }),
  ...(threadId === undefined ? {} : { threadId }),
});

/** The contract `@A2AAgent` recorded on the class being constructed, if any. */
function contractOfClass(target: object): A2AContract | undefined {
  const meta = componentOf(target);
  if (meta?.kind !== "a2a-agent") return undefined;
  const { target: callee, input, output, price } = meta.meta;
  return { target: callee, input, output, ...(price === undefined ? {} : { price }) };
}

/**
 * Calls a workflow exposed over A2A (`a2aHttpListener`). Subclass it with `@A2AAgent({ name, url,
 * target, input, output, price?, deps })` and inject it like any provider; `execute(input)` (#398
 * PR 3) sends the contract's input and returns the remote output, both validated by its DTOs.
 */
export class A2AClient<TIn extends object = object, TOut extends object = object> {
  readonly url: string;

  /** What it calls and how much a call costs: the class's `@A2AAgent`, or the `contract` option. */
  readonly contract: A2AContract | undefined;

  private readonly fetcher: typeof fetch;

  private readonly headers: Record<string, string>;

  constructor(options: A2AClientOptions = {}) {
    this.url = options.url ?? urlOf(new.target, new.target.name);
    this.contract = options.contract ?? contractOfClass(new.target);
    this.fetcher = options.fetcher ?? fetch;
    this.headers = options.headers ?? {};
  }

  /** Extra headers per call (e.g. a fresh token); override in a subclass. */
  protected getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  /**
   * Runs the remote workflow of the contract (#398 PR 3): `input` checked by its input DTO, the
   * output by its output DTO; any other status throws — a remote run a mesh limit stopped
   * (`limit.mesh-loop`, `limit.hops`, #398) as that limit, so the calling step fails with it; any
   * other as `A2ARemoteError`. A client without a contract throws `[a2a.no-contract]`.
   */
  public async execute(input: TIn, call: A2AClientCall = {}): Promise<TOut> {
    const contract = this.#contract();
    const response = await this.send(validate(contract.input, input), call);
    if (response.status !== A2AStatus.Finished) {
      throw meshLimitErrorOf(response) ?? new A2ARemoteError(response);
    }
    // the contract's output DTO is the class's `TOut` (the decorator ties them)
    return validate(contract.output, response.output) as TOut;
  }

  #contract(): A2AContract {
    if (this.contract !== undefined) return this.contract;
    throw new ComponentError(
      `[a2a.no-contract] ${this.constructor.name} declares no contract — @A2AAgent({ target, input, output }) on its class, or the contract option; send(input) runs without one`,
    );
  }

  /**
   * Runs the remote workflow and returns its response whatever the status; a server that refuses
   * the caller (`401` / `403`) throws `A2ACallerRejectedError` (#387), one that refuses the call
   * chain (`409`, #398) `MeshLoopDetectedError` / `HopsLimitExceededError`. Inside an execution
   * the request carries the mesh envelope (`agboss-mesh`) and a `traceparent`.
   */
  public async send(input: unknown, call: A2AClientCall = {}): Promise<A2AExecutionResponse> {
    const target = this.contract?.target;
    const body = requestOf(input, target?.start, call.threadId);
    const streaming = call.onEvent !== undefined;
    const text = JSON.stringify(body);
    const mesh = outboundMeshOf(text, target?.application);
    const response = await this.post("/execute", text, mesh, streaming, call.signal);
    if (!response.ok) throw await this.refusalOf(response);
    const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    const result =
      isStream && response.body !== null
        ? await readEvents(response.body, call.onEvent)
        : A2AResponseSchema.parse(await response.json());
    // a trusted peer's signed report (#398 PR 2): its spend and execution, in the calling step
    if (mesh !== undefined) takeRunReport("a2a", result.report, mesh.bodyHash, this.#priced());
    return result;
  }

  /**
   * Cancels the remote run in flight of the caller's thread, or drops its pause (#398 PR 2:
   * `POST <url>/cancel { threadId }`) — the server resolves the caller first; another tenant's
   * thread of the same id is never touched.
   */
  public async cancel(threadId: string, call: Pick<A2AClientCall, "signal"> = {}): Promise<void> {
    const body = JSON.stringify({ threadId });
    const response = await this.post("/cancel", body, undefined, false, call.signal);
    if (!response.ok) throw await this.refusalOf(response);
    const result = A2AResponseSchema.parse(await response.json());
    if (result.status !== A2AStatus.Cancelled) throw new A2ARemoteError(result);
  }

  /** The contract's price and whom it is paid to (Q6 c: the caller records the larger). */
  #priced(): ContractPrice | undefined {
    const contract = this.contract;
    if (contract?.price === undefined) return undefined;
    return { application: contract.target.application, price: contract.price };
  }

  /** One POST to the server: JSON, its envelope's headers, the caller's own headers last. */
  private async post(
    route: string,
    body: string,
    mesh: OutboundMesh | undefined,
    streaming: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    return this.fetcher(`${this.url}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
        ...meshHeadersOf(mesh),
        ...this.headers,
        ...(await this.getHeaders()),
      },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** A response that is not OK as its error: a refused caller (#387), a refused chain (#398), … */
  private async refusalOf(response: Response): Promise<Error> {
    return (
      (await callerRejectionOf(response)) ??
      (await meshRefusalOfResponse(response)) ??
      new Error(`A2A request to ${this.url} failed with status ${String(response.status)}`)
    );
  }
}
