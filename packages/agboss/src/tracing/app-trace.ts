import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import type { Span, TracerProvider } from "@opentelemetry/api";
import type { TraceLinkContext, TraceMask, TracingAdapter } from "./types.js";

/** What an attribute shows when its mask failed: never its value. */
export const MASK_FAILED = "<masked: the PII mask failed>";

/** A span of a run that has started and not ended, with what must happen before it may end. */
export interface OpenSpan {
  readonly span: Span;
  /** Its masked attributes are set once this settles (never rejects). */
  ready: Promise<void>;
  /** The masks every string it carries goes through, chosen when it started. */
  readonly masks: readonly TraceMask[];
}

/** The caller's `tracerProvider` option, told apart: an adapter is the application's own to shut down. */
export function adapterOf(source: TracerProvider | TracingAdapter): TracingAdapter | undefined {
  const given = source as Partial<TracingAdapter> & { readonly getTracer?: unknown };
  return typeof given.getTracer === "function" || given.tracerProvider === undefined
    ? undefined
    : (source as TracingAdapter);
}

/** An OpenTelemetry SDK provider flushes; the API's `TracerProvider` does not say so. */
const flushable = (provider: TracerProvider): (() => Promise<unknown>) | undefined => {
  const { forceFlush } = provider as { forceFlush?: () => Promise<unknown> };
  return typeof forceFlush === "function" ? forceFlush.bind(provider) : undefined;
};

/**
 * One application instance's tracing (#1324f): the provider its spans go to, the PII mask of each
 * of its workflows, and the runs in flight — shared by all its workflows, so a child workflow's
 * span nests under its parent's and is masked by every workflow of its chain.
 *
 * Masking happens here, before a value reaches a span: an external `TracerProvider` and its
 * processors and exporters only ever see masked values.
 */
export class AppTrace {
  readonly provider: TracerProvider;
  /** The spans of runs in flight, by LangChain run id: a child run's parent is found here. */
  readonly open = new Map<string, OpenSpan>();
  private readonly pending = new Set<Promise<void>>();
  private readonly masks = new Map<string, TraceMask | undefined>();
  private workflows = 0;
  private readonly adapter: TracingAdapter | undefined;

  constructor(source: TracerProvider | TracingAdapter) {
    this.adapter = adapterOf(source);
    this.provider = this.adapter?.tracerProvider ?? (source as TracerProvider);
  }

  /** A workflow of the application starts tracing with its mask. */
  join(workflow: string, mask: TraceMask | undefined): void {
    this.masks.set(workflow, mask);
    this.workflows += 1;
  }

  /**
   * The masks of every workflow of a span's chain (#1150: a child's spans by its ancestors'
   * policies too); the union of the application's when the chain is not known or names a workflow
   * that has none here (fail closed).
   */
  masksOf(chain: readonly string[] | undefined): readonly TraceMask[] {
    const names = [...new Set(chain ?? [])];
    const isKnown = names.length > 0 && names.every((name) => this.masks.has(name));
    const picked = isKnown ? names.map((name) => this.masks.get(name)) : [...this.masks.values()];
    return [...new Set(picked.filter((mask): mask is TraceMask => mask !== undefined))];
  }

  /** Keeps `work` (a span's masking or its end) in the pending set until it settles. */
  track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private async settled(): Promise<void> {
    // LangChain may still be running handlers in the background: their spans end here
    await awaitAllCallbacks();
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** A link to one execution, when the adapter builds one; a backend that throws gives none. */
  traceUrl(ctx: TraceLinkContext): string | undefined {
    try {
      return this.adapter?.traceUrl?.(ctx);
    } catch {
      return undefined;
    }
  }

  /**
   * A workflow of the application stops: what is in flight settles, the provider is flushed, and
   * with the last workflow an owned adapter is shut down. A provider the caller owns is only
   * flushed. Returns whether it was the last.
   */
  async leave(): Promise<boolean> {
    await this.settled();
    await (this.adapter?.forceFlush?.() ?? flushable(this.provider)?.());
    this.workflows -= 1;
    const isLast = this.workflows === 0;
    if (isLast) await this.adapter?.shutdown?.();
    return isLast;
  }
}
