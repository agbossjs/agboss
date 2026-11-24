import { Injectable } from "../../../src/index.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  TRANSIENT_FAILURES,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelProviderStream,
  type TokenUsage,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { bedrockApplicationOn, workflowsOn } from "../transport/bedrock-apps.fixture.js";

/** #1011: a transport provider that streams its text — a scripted SDK client of streams. */

/** What the provider asked of the SDK. */
export interface StreamInvocation {
  readonly model: string;
  readonly toolCount: number;
  readonly signal: AbortSignal;
}

/** The SDK's way to open one stream (a test scripts it). */
export type StreamScript = (invocation: StreamInvocation) => ModelProviderStream;

@Injectable()
export class StreamSdkClient {
  readonly opened: StreamInvocation[] = [];
  readonly completed: StreamInvocation[] = [];

  open(invocation: StreamInvocation): ModelProviderStream {
    this.opened.push(invocation);
    throw new Error("StreamSdkClient: no script");
  }

  complete(invocation: StreamInvocation): Promise<ModelProviderResponse> {
    this.completed.push(invocation);
    return Promise.resolve({ text: "whole", usage: { inputTokens: 10, outputTokens: 5 } });
  }
}

/** Answers with the scripts in order (the last repeats). */
export class ScriptedStreamClient extends StreamSdkClient {
  constructor(private readonly scripts: readonly StreamScript[]) {
    super();
  }

  override open(invocation: StreamInvocation): ModelProviderStream {
    const script = this.scripts[Math.min(this.opened.length, this.scripts.length - 1)];
    this.opened.push(invocation);
    if (script === undefined) throw new Error("no script");
    return script(invocation);
  }
}

export const usageOf = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Never settles: an SDK that forgot to end it. */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

async function* chunksThen(chunks: readonly string[], then: () => Promise<void>) {
  for (const chunk of chunks) yield chunk;
  await then();
}

/** A stream of `chunks` that ends cleanly, its result settling with `usage`. */
export const streamOf =
  (chunks: readonly string[], usage = usageOf(1_000_000, 500_000)): StreamScript =>
  () => ({
    textStream: chunksThen(chunks, () => Promise.resolve()),
    result: Promise.resolve({ usage }),
  });

/** `chunks`, then the stream throws `error`; its result settles with what was used up to then, or rejects. */
export const failingAfter =
  (
    chunks: readonly string[],
    error: Error,
    usage: "settles" | "rejects" = "settles",
  ): StreamScript =>
  () => ({
    textStream: chunksThen(chunks, () => Promise.reject(error)),
    result:
      usage === "settles" ? Promise.resolve({ usage: usageOf(100, 50) }) : Promise.reject(error),
  });

/** `chunks`, a clean end, and a result that rejects. */
export const usageRejects =
  (chunks: readonly string[], error: Error): StreamScript =>
  () => ({
    textStream: chunksThen(chunks, () => Promise.resolve()),
    result: Promise.reject(error),
  });

/** `chunks`, a clean end, and a result that never settles. */
export const usageNeverSettles =
  (chunks: readonly string[]): StreamScript =>
  () => ({
    textStream: chunksThen(chunks, () => Promise.resolve()),
    result: never(),
  });

/** `chunks`, then the stream goes silent (no end, no error). */
export const silentAfter =
  (chunks: readonly string[]): StreamScript =>
  () => ({
    textStream: chunksThen(chunks, never),
    result: never(),
  });

/** The stream fails before any chunk. */
export const failingFirst =
  (error: Error): StreamScript =>
  () => ({
    textStream: chunksThen([], () => Promise.reject(error)),
    result: Promise.reject(error),
  });

/** Chunks, then it waits for the request's signal and ends with its reason (what an SDK does). */
export const abortedAfter =
  (chunks: readonly string[]): StreamScript =>
  (invocation) => {
    const stopped = new Promise<never>((_resolve, reject) => {
      invocation.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted by the request's signal", { cause: invocation.signal.reason }));
        },
        { once: true },
      );
    });
    stopped.catch(() => undefined);
    return {
      textStream: chunksThen(chunks, () => stopped),
      result: stopped,
    };
  };

@ModelProvider({
  name: "stream-1011-model-provider",
  description: "A transport that streams",
  serves: [/^stream-t\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "stream-t/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(2),
    jitter: false,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 2, window: minutes(1), openFor: minutes(1) },
  deps: [StreamSdkClient],
})
export class StreamingModelProvider implements ModelProviderHandler {
  constructor(private readonly client: StreamSdkClient) {}

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.client.complete(invocationOf(request));
  }

  stream(request: ModelProviderRequest): ModelProviderStream {
    return this.client.open(invocationOf(request));
  }
}

const invocationOf = (request: ModelProviderRequest): StreamInvocation => ({
  model: request.model,
  toolCount: request.tools.length,
  signal: request.signal,
});

export const STREAM_DESK = workflowsOn("stream-t/model", "stream-1011");

export const TransportStreamApplication = bedrockApplicationOn({
  name: "stream-1011-application",
  desk: STREAM_DESK,
  providers: [StreamingModelProvider, StreamSdkClient],
});
