import type { AttributeValue, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TraceMask } from "./types.js";

/**
 * The one span processor of the process's Langfuse provider (#1130). Langfuse's LangChain handler
 * exports through a single process-wide provider, so every workflow of every application in the
 * process is a route here. Each span is bound when it starts to the route of the handler that
 * started it (`starting`), or to its parent's — so it is exported only through its own
 * application's processor — and masked when it ends:
 *
 * - by the masks of the workflow it belongs to — the `workflowName` every step's LangChain
 *   metadata carries (a child's own workflow for a child's steps): exactly that run's policies;
 * - when its application has no route of that workflow (a missing name), by every route of its
 *   application in turn — the union, fail closed.
 *
 * A route that leaves keeps its mask for the spans started under it; a span whose processor has
 * shut down is dropped. A span no handler of a route started (a project's own Langfuse span) is
 * exported only when the process has one processor, masked by every route's mask; with several
 * it has no known destination and is dropped. Every string attribute is masked (input, output, the
 * flattened metadata, the trace's fields). A mask that throws leaves `MASK_FAILED` in place.
 */

/** The span attribute Langfuse writes a step's `metadata.workflowName` to. */
export const WORKFLOW_ATTRIBUTE = "langfuse.observation.metadata.workflowName";

/** What an attribute shows when its mask failed: never its value. */
export const MASK_FAILED = "<masked: the PII mask failed>";

/** One workflow's tracing: whose it is, its mask, and where its spans are exported. */
export interface TraceRouteOptions {
  /** The application instance it belongs to (any object of its own): its routes mask together. */
  readonly owner: object;
  /** The workflow whose spans this route masks. */
  readonly workflow: string;
  /** Its observability mask; absent = its workflow masks nothing. */
  readonly mask?: TraceMask | undefined;
  /** Routes with the same key share one exporting processor. */
  readonly settingsKey: string;
  /** The exporting processor, made for the first route of its key. */
  readonly processor: () => SpanProcessor;
}

/** A route while its workflow traces. */
export interface TraceRoute {
  /** Runs `start` (a handler's span start) with the spans it starts bound to this route. */
  readonly starting: <T>(start: () => T) => T;
  /** Waits for its spans in flight, then leaves (its processor shut down with its last route). */
  readonly remove: () => Promise<void>;
}

interface Pipeline {
  readonly key: string;
  readonly processor: SpanProcessor;
  routes: number;
  isClosed: boolean;
}

/** An application's routes, kept (removed ones too) while it has a live route or an open span. */
interface Owner {
  readonly key: object;
  readonly routes: Route[];
  live: number;
  open: number;
}

interface Route {
  readonly workflow: string;
  readonly mask: TraceMask | undefined;
  readonly pipeline: Pipeline;
  readonly owner: Owner;
}

/** What a started span is bound to: its route, or (a span of no route) the only processor. */
type Binding =
  | { readonly route: Route; readonly pipeline: Pipeline }
  | { readonly route: undefined; readonly pipeline: Pipeline };

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

const masksOfRoutes = (routes: readonly Route[]): TraceMask[] =>
  routes.flatMap((route) => (route.mask === undefined ? [] : [route.mask]));

export class TraceRouter implements SpanProcessor {
  private readonly owners = new Map<object, Owner>();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly boundSpans = new WeakMap<object, Binding>();
  /** The route of each open span by its id: a child span is its parent's. */
  private readonly bySpanId = new Map<string, Route>();
  private readonly pending = new Set<Promise<void>>();
  /** The route whose handler is starting a span right now (synchronously). */
  private startingOn: Route | undefined;

  /** Whether no route is live. */
  get isIdle(): boolean {
    return [...this.owners.values()].every((owner) => owner.live === 0);
  }

  addRoute(options: TraceRouteOptions): TraceRoute {
    const pipeline = this.pipelines.get(options.settingsKey) ?? {
      key: options.settingsKey,
      processor: options.processor(),
      routes: 0,
      isClosed: false,
    };
    this.pipelines.set(pipeline.key, pipeline);
    pipeline.routes += 1;
    const owner = this.owners.get(options.owner) ?? {
      key: options.owner,
      routes: [],
      live: 0,
      open: 0,
    };
    this.owners.set(options.owner, owner);
    owner.live += 1;
    const route: Route = { workflow: options.workflow, mask: options.mask, pipeline, owner };
    owner.routes.push(route);
    let isRemoved = false;
    return {
      starting: (start) => {
        const before = this.startingOn;
        this.startingOn = route;
        try {
          return start();
        } finally {
          this.startingOn = before;
        }
      },
      remove: async () => {
        if (isRemoved) return;
        isRemoved = true;
        await this.settled();
        owner.live -= 1;
        this.forgetIfDone(owner);
        pipeline.routes -= 1;
        if (pipeline.routes > 0) return;
        pipeline.isClosed = true;
        this.pipelines.delete(pipeline.key);
        await pipeline.processor.shutdown();
      },
    };
  }

  private forgetIfDone(owner: Owner): void {
    if (owner.live === 0 && owner.open === 0 && this.owners.get(owner.key) === owner)
      this.owners.delete(owner.key);
  }

  /** The route a starting span belongs to: its handler's, else its parent's. */
  private routeAtStart(span: Span): Route | undefined {
    if (this.startingOn !== undefined) return this.startingOn;
    const parent = span.parentSpanContext?.spanId;
    return parent === undefined ? undefined : this.bySpanId.get(parent);
  }

  onStart(span: Span, parentContext: Context): void {
    const route = this.routeAtStart(span);
    const binding =
      route === undefined ? this.unownedBinding() : { route, pipeline: route.pipeline };
    if (binding === undefined || binding.pipeline.isClosed) return; // no known destination: dropped
    this.boundSpans.set(span, binding);
    if (binding.route !== undefined) {
      binding.route.owner.open += 1;
      this.bySpanId.set(span.spanContext().spanId, binding.route);
    }
    binding.pipeline.processor.onStart(span, parentContext);
  }

  /** A span of no route goes to the only processor of the process; with several, nowhere. */
  private unownedBinding(): Binding | undefined {
    const [only, ...others] = [...this.pipelines.values()];
    return only === undefined || others.length > 0
      ? undefined
      : { route: undefined, pipeline: only };
  }

  onEnd(span: ReadableSpan): void {
    const binding = this.boundSpans.get(span);
    if (binding === undefined) return;
    this.boundSpans.delete(span);
    if (binding.route !== undefined) this.bySpanId.delete(span.spanContext().spanId);
    // the masks are chosen now, from the routes the span was bound to (kept while it is open)
    const masks = this.masksOf(span, binding.route);
    const done = this.maskInPlace(span, masks).then(
      () => {
        // a processor that shut down while the span was open exports nothing of it
        if (!binding.pipeline.isClosed) binding.pipeline.processor.onEnd(span);
      },
      () => undefined,
    );
    this.pending.add(done);
    void done.finally(() => {
      this.pending.delete(done);
      if (binding.route === undefined) return;
      binding.route.owner.open -= 1;
      this.forgetIfDone(binding.route.owner);
    });
  }

  /** Its own workflow's masks in its application; else that application's union; a span of no route: every route's. */
  masksOf(span: ReadableSpan, route: Route | undefined): readonly TraceMask[] {
    if (route === undefined)
      return masksOfRoutes([...this.owners.values()].flatMap((owner) => owner.routes));
    const workflow = span.attributes[WORKFLOW_ATTRIBUTE];
    const own = route.owner.routes.filter((each) => each.workflow === workflow);
    return masksOfRoutes(own.length > 0 ? own : route.owner.routes);
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
    for (const each of pipelines) each.isClosed = true;
    await Promise.all(pipelines.map((each) => each.processor.shutdown()));
  }
}
