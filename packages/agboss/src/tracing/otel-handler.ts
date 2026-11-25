import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { context, SpanKind, trace, type Tracer } from "@opentelemetry/api";
import type { AppTrace, OpenSpan } from "./app-trace.js";
import {
  chainOf,
  maskedAttributes,
  modelOf,
  recordEnd,
  serializedName,
  startTexts,
  usageOf,
  type RunEnd,
} from "./span-values.js";
import type { TraceContext } from "./types.js";

/**
 * The framework's own OpenTelemetry emitter (#1324f): a LangChain callback handler that turns each
 * chain, model call, tool call and retrieval of a run into a span on the caller's provider.
 *
 * **Every value a run produced is masked before it is set on a span.** A span starts carrying only
 * what the code itself names (its operation, its workflow's name and chain); each of its inputs,
 * outputs, metadata, session and error texts goes through the PII policies of every workflow of its
 * chain (#1150) and only then through `setAttributes` / `addEvent` / `setStatus` (`span-values.ts`).
 * A processor or exporter of the provider — one that is not ours — never sees an unmasked value, so
 * nothing here relies on mutating a finished span. A mask that throws leaves `MASK_FAILED`.
 */

const OPERATION = "agboss.operation";
/** The workflow the span's step belongs to (a child's own, not its root's). */
export const WORKFLOW_ATTRIBUTE = "agboss.workflow.name";
/** The workflows its masks come from: the root's name, every ancestor's and its own, as a JSON array (#1150). */
export const WORKFLOW_CHAIN_ATTRIBUTE = "agboss.workflow.chain";

type Metadata = Record<string, unknown> | undefined;

/** What a run start gives the emitter. */
interface RunStart {
  readonly runId: string;
  readonly parentRunId: string | undefined;
  readonly operation: "chain" | "llm" | "tool" | "retriever";
  readonly name: string;
  readonly input: unknown;
  readonly metadata: Metadata;
  readonly tags: readonly string[] | undefined;
  readonly model?: string | undefined;
}

export class OtelCallbackHandler extends BaseCallbackHandler {
  name = "agboss-otel";

  constructor(
    private readonly app: AppTrace,
    private readonly tracer: Tracer,
    private readonly run: TraceContext,
  ) {
    super();
  }

  /** Starts the span now (its time and parent are the run's); a tracing failure is never the run's. */
  private begin(start: RunStart): void {
    try {
      this.start(start);
    } catch {
      // never thrown into the run
    }
  }

  private start(start: RunStart): void {
    const parent = this.app.open.get(start.parentRunId ?? "")?.span;
    const { workflow, chain } = chainOf(start.metadata);
    const masks = this.app.masksOf(chain);
    const span = this.tracer.startSpan(
      start.name,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [OPERATION]: start.operation,
          [WORKFLOW_ATTRIBUTE]: workflow ?? this.run.bundle,
          ...(chain === undefined ? {} : { [WORKFLOW_CHAIN_ATTRIBUTE]: JSON.stringify(chain) }),
        },
      },
      parent === undefined ? context.active() : trace.setSpan(context.active(), parent),
    );
    const open: OpenSpan = { span, ready: Promise.resolve(), masks };
    this.app.open.set(start.runId, open);
    const texts = startTexts(start, parent === undefined ? this.run : undefined);
    this.settle(open, async () => {
      span.setAttributes(await maskedAttributes(texts, masks));
    });
  }

  /** Runs `work` after what the span waits for, never rejecting; its end waits for it too. */
  private settle(open: OpenSpan, work: () => Promise<void>): void {
    open.ready = open.ready.then(work).catch(() => undefined);
    this.app.track(open.ready);
  }

  /** Ends the span once everything before it is set; `end` is masked like everything else. */
  private finish(runId: string, end: RunEnd): void {
    const open = this.app.open.get(runId);
    if (open === undefined) return;
    this.app.open.delete(runId);
    this.settle(open, () => recordEnd(open, end));
    this.settle(open, () => {
      open.span.end();
      return Promise.resolve();
    });
  }

  // LangChain calls these as (…, runId, parentRunId, tags, metadata, …): its typings list them in
  // another order for chains, so the starts are written out against what the callback manager does.
  override handleChainStart(
    chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    const name = runName ?? serializedName(chain);
    this.begin({ runId, parentRunId, operation: "chain", name, input: inputs, metadata, tags });
  }

  override handleLLMStart(
    llm: unknown,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName ?? serializedName(llm);
    const model = modelOf(extra, metadata);
    this.begin({
      runId,
      parentRunId,
      operation: "llm",
      name,
      input: prompts,
      metadata,
      tags,
      model,
    });
  }

  override handleChatModelStart(
    llm: unknown,
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName ?? serializedName(llm);
    const model = modelOf(extra, metadata);
    this.begin({
      runId,
      parentRunId,
      operation: "llm",
      name,
      input: messages,
      metadata,
      tags,
      model,
    });
  }

  override handleToolStart(
    tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName ?? serializedName(tool);
    this.begin({ runId, parentRunId, operation: "tool", name, input, metadata, tags });
  }

  override handleRetrieverStart(
    retriever: unknown,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName ?? serializedName(retriever);
    this.begin({ runId, parentRunId, operation: "retriever", name, input: query, metadata, tags });
  }

  override handleChainEnd(outputs: unknown, runId: string): void {
    this.finish(runId, { output: outputs });
  }

  override handleLLMEnd(output: unknown, runId: string): void {
    const generations = (output as { generations?: unknown } | null)?.generations;
    this.finish(runId, { output: generations ?? output, numbers: usageOf(output) });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    this.finish(runId, { output });
  }

  override handleRetrieverEnd(documents: unknown, runId: string): void {
    this.finish(runId, { output: documents });
  }

  override handleChainError(error: unknown, runId: string): void {
    this.finish(runId, { error });
  }

  override handleLLMError(error: unknown, runId: string): void {
    this.finish(runId, { error });
  }

  override handleToolError(error: unknown, runId: string): void {
    this.finish(runId, { error });
  }

  override handleRetrieverError(error: unknown, runId: string): void {
    this.finish(runId, { error });
  }
}
