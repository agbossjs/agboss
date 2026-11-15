import type { AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TraceMask } from "./types.js";

/**
 * The one span processor of the process's Langfuse provider (#1130). Langfuse's LangChain handler
 * exports through a single process-wide provider, so every workflow of every application in the
 * process is a route here, and each ended span is masked before it is exported:
 *
 * - by the masks of the workflow it belongs to — the `workflowName` every step's LangChain
 *   metadata carries (a child's own workflow for a child's steps): exactly that run's policies;
 * - when no live route is that workflow (a span of no run, a missing name), by every route's mask
 *   in turn — the union of the process's policies, fail closed.
 *
 * Every string attribute is masked (input, output, the flattened metadata, the trace's fields):
 * nothing a span carries leaves unmasked. A mask that throws leaves `MASK_FAILED` in place.
 */

/** The span attribute Langfuse writes a step's `metadata.workflowName` to. */
export const WORKFLOW_ATTRIBUTE = "langfuse.observation.metadata.workflowName";

/** What an attribute shows when its mask failed: never its value. */
export const MASK_FAILED = "<masked: the PII mask failed>";

/** One workflow's tracing: its name, its mask, and where its spans are exported. */
export interface TraceRouteOptions {
  /** The workflow whose spans this route masks; absent = it only adds its mask to the union. */
  readonly workflow?: string | undefined;
  /** Its observability mask; absent = its workflow masks nothing. */
  readonly mask?: TraceMask | undefined;
  /** Routes with the same key share one exporting processor. */
  readonly settingsKey: string;
  /** The exporting processor, made for the first route of its key. */
  readonly processor: () => SpanProcessor;
}

/** A route while its workflow traces. */
export interface TraceRoute {
  /** Waits for its spans in flight, then leaves (its processor shut down with its last route). */
  readonly remove: () => Promise<void>;
}

interface Pipeline {
  readonly key: string;
  readonly processor: SpanProcessor;
  routes: number;
}

interface Route {
  readonly workflow: string | undefined;
  readonly mask: TraceMask | undefined;
  readonly pipeline: Pipeline;
}

type MutableAttributes = Record<string, AttributeValue | undefined>;

const isMaskable = (value: AttributeValue | undefined): value is string | string[] =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

async function maskedValue(
  value: string | string[],
  masks: readonly TraceMask[],
): Promise<AttributeValue> {
  let shown: unknown = value;
  for (const mask of masks) shown = await mask.traceData(shown);
  return isMaskable(shown as AttributeValue) ? (shown as AttributeValue) : MASK_FAILED;
}

export class TraceRouter implements SpanProcessor {
  private readonly routes = new Set<Route>();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly startedOn = new WeakMap<object, Pipeline>();
  private readonly pending = new Set<Promise<void>>();

  /** Whether no route is left. */
  get isIdle(): boolean {
    return this.routes.size === 0;
  }

  addRoute(options: TraceRouteOptions): TraceRoute {
    const pipeline = this.pipelines.get(options.settingsKey) ?? {
      key: options.settingsKey,
      processor: options.processor(),
      routes: 0,
    };
    this.pipelines.set(pipeline.key, pipeline);
    pipeline.routes += 1;
    const route: Route = { workflow: options.workflow, mask: options.mask, pipeline };
    this.routes.add(route);
    let isRemoved = false;
    return {
      remove: async () => {
        if (isRemoved) return;
        isRemoved = true;
        await this.settled();
        this.routes.delete(route);
        pipeline.routes -= 1;
        if (pipeline.routes > 0) return;
        this.pipelines.delete(pipeline.key);
        await pipeline.processor.shutdown();
      },
    };
  }

  /** The newest route's processor exports what starts now (a process has one Langfuse, as a rule). */
  private get current(): Pipeline | undefined {
    return [...this.routes].at(-1)?.pipeline;
  }

  onStart(span: Span, parentContext: Context): void {
    const pipeline = this.current;
    if (pipeline === undefined) return;
    this.startedOn.set(span, pipeline);
    pipeline.processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const pipeline = this.startedOn.get(span);
    if (pipeline === undefined) return;
    // the masks are chosen now, while the span's routes are live
    const masks = this.masksOf(span);
    const done = this.maskInPlace(span, masks).then(
      () => {
        pipeline.processor.onEnd(span);
      },
      () => undefined,
    );
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
  }

  /** Its own workflow's masks; else every route's (fail closed). */
  masksOf(span: ReadableSpan): readonly TraceMask[] {
    const workflow = span.attributes[WORKFLOW_ATTRIBUTE];
    const routes = [...this.routes];
    const own = routes.filter(
      (route) => route.workflow !== undefined && route.workflow === workflow,
    );
    return (own.length > 0 ? own : routes).flatMap((route) =>
      route.mask === undefined ? [] : [route.mask],
    );
  }

  private async maskInPlace(span: ReadableSpan, masks: readonly TraceMask[]): Promise<void> {
    if (masks.length === 0) return;
    const attributes: MutableAttributes = span.attributes;
    for (const [key, value] of Object.entries(attributes)) {
      if (!isMaskable(value)) continue;
      try {
        attributes[key] = await maskedValue(value, masks);
      } catch {
        attributes[key] = MASK_FAILED;
      }
    }
  }

  private async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async forceFlush(): Promise<void> {
    await this.settled();
    await Promise.all([...this.pipelines.values()].map((each) => each.processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await this.settled();
    const pipelines = [...this.pipelines.values()];
    this.pipelines.clear();
    await Promise.all(pipelines.map((each) => each.processor.shutdown()));
  }
}
