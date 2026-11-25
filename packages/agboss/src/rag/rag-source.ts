import { ConfigError } from "../core/error-families/config-errors.js";
import type { ExecutionContext } from "../flow/context/execution-context.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { currentFrame, type Frame } from "../flow/context/frame.js";
import { SpendOutsideStepError } from "../components/spend-recorder.js";
import type { RagSearchResultsDto } from "./dto.js";
import { retrievalRecordsOf } from "./retrieval-spend.js";
import type {
  KnowledgeRetrieval,
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
  RagSearchOptions,
} from "./types.js";

/** What the core wires into a source it created: the retrieval pipeline of its `@Rag` (internal). */
export interface RagRuntime {
  readonly name: string;
  readonly topK: number;
  readonly retrieve: (
    query: string,
    options: { readonly topK: number; readonly signal: AbortSignal; readonly filter?: unknown },
  ) => Promise<KnowledgeRetrieval>;
}

const runtimes = new WeakMap<object, RagRuntime>();

/** The step's or tool call's frame a search runs in; none, or an ended one, is `context.unavailable`. */
function openFrameOf(name: string): Frame {
  const frame = currentFrame();
  if (frame === undefined)
    throw ExecutionContextUnavailableError.outside({
      consumer: `@Rag ${name}`,
      field: "executionContext",
    });
  if (frame.isClosed())
    throw ExecutionContextUnavailableError.ended(frame.step, frame.execution.executionId);
  return frame;
}

/**
 * A search's spend into the frame's call, each record under its own caller. A paid search with no
 * frame to report to fails closed: its money is never lost, nor the search free.
 */
function reportSpend(frame: Frame, name: string, retrieval: KnowledgeRetrieval): void {
  const records = retrievalRecordsOf(name, retrieval);
  const report = frame.services.reportUsage;
  if (report === undefined && records.length > 0)
    throw new SpendOutsideStepError({
      message: `[spend.outside-step] @Rag ${name} made a paid search outside a step or a tool call — search while the step (or the tool call) runs`,
    });
  for (const record of records) report?.(record);
}

/** The core binds a source's pipeline when its container creates it (internal). */
export const bindRagRuntime = (source: object, runtime: RagRuntime): void => {
  runtimes.set(source, runtime);
};

/** Whether `value` is a source the core wired (internal). */
export const ragRuntimeOf = (source: object): RagRuntime | undefined => runtimes.get(source);

/**
 * A knowledge base: `@Rag({ name, description, scope, topK })` on a class that extends `RagSource`
 * and implements `retrieve`. Agents list it in `rag: [...]` (its passages come before the first
 * model call); a `@Tool` or `@Action` injects it (`deps: [MyRag]`) and calls `search(query)`.
 *
 * `retrieve` is protected on purpose: `search` is the only way in, and it runs the pipeline —
 * scope resolution (a query never reads another scope's passages), reranking, PII policies,
 * spend and tokens into the budgets, tracing.
 */
export abstract class RagSource<TFilter = never> {
  /** The scope's passages of `query`: `options.topK` of them, from `options.scopeId`'s scope only. */
  protected abstract retrieve(
    query: string,
    options: RagRetrieveOptions<TFilter>,
  ): RagRetrieval | Promise<RagRetrieval>;

  /** Optional: build or update one scope's index (`agboss rag index --scope <id>`). */
  protected index?(options: RagIndexOptions): RagIndexReport | Promise<RagIndexReport>;

  /** The scope's id of the current call: required by a `@Rag` with `scope: RagScope.Custom`. */
  resolveScope?(context: ExecutionContext): string;

  /**
   * Searches this knowledge base through the framework's pipeline: inside a tool call or a step.
   * `options.topK` is this call's count (default `@Rag({ topK })`), `options.filter` goes to
   * `retrieve` as it is. The spend and tokens of the retrieval (and the reranker's) join the call's.
   */
  async search(query: string, options?: RagSearchOptions<TFilter>): Promise<RagSearchResultsDto> {
    const runtime = runtimes.get(this);
    if (runtime === undefined)
      throw new ConfigError.Component({
        message: `[rag.unbound] ${this.constructor.name}.search() ran on an instance the application did not create — inject it (deps: [${this.constructor.name}]) instead of constructing it`,
      });
    const frame = openFrameOf(runtime.name);
    const retrieval = await runtime.retrieve(query, {
      topK: options?.topK ?? runtime.topK,
      signal: frame.execution.signal,
      ...(options?.filter === undefined ? {} : { filter: options.filter }),
    });
    reportSpend(frame, runtime.name, retrieval);
    return { results: retrieval.results };
  }
}

interface Sourced {
  retrieve(
    query: string,
    options: RagRetrieveOptions<unknown>,
  ): RagRetrieval | Promise<RagRetrieval>;
  index?(options: RagIndexOptions): RagIndexReport | Promise<RagIndexReport>;
}

/** The core's way into a source's protected `retrieve` (internal). */
export async function retrieveOf(
  source: object,
  query: string,
  options: RagRetrieveOptions<unknown>,
): Promise<RagRetrieval> {
  return await (source as Sourced).retrieve(query, options);
}

/** The core's way into a source's protected `index`; `undefined` when it has none (internal). */
export async function indexOf(
  source: object,
  options: RagIndexOptions,
): Promise<RagIndexReport | undefined> {
  const sourced = source as Sourced;
  return sourced.index === undefined ? undefined : await sourced.index(options);
}

/** Whether `value` is a source (internal): what the container binds a pipeline to. */
export const isRagSource = (value: unknown): value is RagSource => value instanceof RagSource;
