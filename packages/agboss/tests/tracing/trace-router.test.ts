/**
 * #1130: the process's one Langfuse span processor exports each span only through its own
 * application's processor, masked by its own workflow's policies — fail closed everywhere else.
 */
import { ROOT_CONTEXT, trace, type Attributes, type Span as ApiSpan } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { getLangfuseTracerProvider } from "@langfuse/tracing";
import { describe, expect, it } from "vitest";
import { langfuseTracing } from "../../src/tracing/langfuse.js";
import {
  MASK_FAILED,
  TraceRouter,
  WORKFLOW_ATTRIBUTE,
  WORKFLOW_CHAIN_ATTRIBUTE,
  type TraceRoute,
} from "../../src/tracing/trace-router.js";
import type { TraceMask } from "../../src/tracing/types.js";

/** A processor that keeps what it is handed. */
class KeptSpans implements SpanProcessor {
  readonly started: object[] = [];
  readonly ended: ReadableSpan[] = [];
  isShutDown = false;
  onStart(span: Span): void {
    this.started.push(span);
  }
  onEnd(span: ReadableSpan): void {
    this.ended.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    this.isShutDown = true;
    return Promise.resolve();
  }
}

/** A mask that replaces one word, the way a policy replaces its kind. */
const hiding = (word: string): TraceMask => ({
  traceData: (data) =>
    Promise.resolve(
      Array.isArray(data)
        ? data.map((item) => String(item).replaceAll(word, `<${word}>`))
        : String(data).replaceAll(word, `<${word}>`),
    ),
});

/** A tracer whose spans go through `router`, as Langfuse's handler's do. */
const tracerOn = (router: TraceRouter) =>
  new BasicTracerProvider({ spanProcessors: [router] }).getTracer("trace-router-test");

/** A span started (by a route's handler when `route` is given) and still open. */
const started = (
  router: TraceRouter,
  attributes: Attributes,
  route?: TraceRoute,
  parent?: ApiSpan,
): ApiSpan => {
  const tracer = tracerOn(router);
  const context = parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent);
  const start = () => tracer.startSpan("step", { attributes }, context);
  return route === undefined ? start() : route.starting(start);
};

/** What `processor` was last handed once `span` ended and the router settled. */
async function endedOn(router: TraceRouter, span: ApiSpan, processor: KeptSpans) {
  span.end();
  await router.forceFlush();
  return processor.ended.at(-1);
}

/** One application of two workflows on one processor: ticket lists a policy, refund none. */
const oneApplication = () => {
  const processor = new KeptSpans();
  const router = new TraceRouter();
  const owner = {};
  const ticket = router.addRoute({
    owner,
    workflow: "ticket-workflow",
    mask: hiding("TCK-1"),
    settingsKey: "lf",
    processor: () => processor,
  });
  const refund = router.addRoute({
    owner,
    workflow: "refund-workflow",
    settingsKey: "lf",
    processor: () => processor,
  });
  return { router, processor, ticket, refund };
};

describe("#1130: TraceRouter", () => {
  it("R1: a span of a workflow is masked by that workflow's mask — the one built last lists none", async () => {
    const { router, processor, refund } = oneApplication();

    const span = started(
      router,
      {
        [WORKFLOW_ATTRIBUTE]: "ticket-workflow",
        "langfuse.observation.input": '{"text":"about TCK-1"}',
        "langfuse.observation.metadata.note": "TCK-1",
        "langfuse.trace.tags": ["TCK-1"],
        "langfuse.observation.level": 1,
      },
      refund, // the handler of the newest route: the span names its own workflow
    );
    const shown = await endedOn(router, span, processor);

    expect(processor.started).toHaveLength(1);
    expect(JSON.stringify(shown?.attributes)).not.toMatch(/TCK-1(?!>)/);
    expect(shown?.attributes["langfuse.observation.metadata.note"]).toBe("<TCK-1>");
    expect(shown?.attributes["langfuse.trace.tags"]).toEqual(["<TCK-1>"]);
    expect(shown?.attributes["langfuse.observation.level"]).toBe(1);
  });

  it("R2: a span of a workflow without policies is not masked by another's", async () => {
    const { router, processor, refund } = oneApplication();

    const span = started(
      router,
      { [WORKFLOW_ATTRIBUTE]: "refund-workflow", "langfuse.observation.input": "TCK-1" },
      refund,
    );

    expect((await endedOn(router, span, processor))?.attributes["langfuse.observation.input"]).toBe(
      "TCK-1",
    );
  });

  it("R3: a span naming no workflow of its application is masked by all of the application's", async () => {
    const { router, processor, refund } = oneApplication();

    const nameless = started(router, { "langfuse.observation.input": "TCK-1" }, refund);
    expect(
      (await endedOn(router, nameless, processor))?.attributes["langfuse.observation.input"],
    ).toBe("<TCK-1>");
    const unknown = started(
      router,
      { [WORKFLOW_ATTRIBUTE]: "gone-workflow", "langfuse.observation.input": "TCK-1" },
      refund,
    );
    expect(
      (await endedOn(router, unknown, processor))?.attributes["langfuse.observation.input"],
    ).toBe("<TCK-1>");
  });

  it("R4: a mask that throws leaves MASK_FAILED, never the value", async () => {
    const router = new TraceRouter();
    const processor = new KeptSpans();
    const broken: TraceMask = { traceData: () => Promise.reject(new Error("TCK-1")) };
    const route = router.addRoute({
      owner: {},
      workflow: "w",
      mask: broken,
      settingsKey: "lf",
      processor: () => processor,
    });

    const span = started(
      router,
      { [WORKFLOW_ATTRIBUTE]: "w", "langfuse.observation.output": "TCK-1" },
      route,
    );
    const shown = await endedOn(router, span, processor);

    expect(shown?.attributes["langfuse.observation.output"]).toBe(MASK_FAILED);
    expect(shown?.attributes[WORKFLOW_ATTRIBUTE]).toBe(MASK_FAILED);
  });

  it("R5: a route that leaves while its span is open still masks it — never exported unmasked", async () => {
    const { router, processor, ticket } = oneApplication();

    const span = started(
      router,
      { [WORKFLOW_ATTRIBUTE]: "ticket-workflow", "langfuse.observation.input": "TCK-1" },
      ticket,
    );
    await ticket.remove();
    const shown = await endedOn(router, span, processor);

    expect(processor.isShutDown).toBe(false);
    expect(shown?.attributes["langfuse.observation.input"]).toBe("<TCK-1>");
  });

  it("R6: a span whose processor shut down (its last route left) is dropped", async () => {
    const { router, processor, ticket, refund } = oneApplication();

    const span = started(
      router,
      { [WORKFLOW_ATTRIBUTE]: "ticket-workflow", "langfuse.observation.input": "TCK-1" },
      ticket,
    );
    await ticket.remove();
    await refund.remove();
    span.end();
    await router.forceFlush();

    expect(processor.isShutDown).toBe(true);
    expect(processor.ended).toEqual([]);
    expect(router.isIdle).toBe(true);
  });

  it("R7: two applications on two processors — each span, a child's too, reaches only its own, masked by its own", async () => {
    const router = new TraceRouter();
    const ownA = new KeptSpans();
    const ownB = new KeptSpans();
    const a = router.addRoute({
      owner: {},
      workflow: "desk-workflow",
      mask: hiding("TCK-1"),
      settingsKey: "lf-a",
      processor: () => ownA,
    });
    const b = router.addRoute({
      owner: {},
      workflow: "desk-workflow", // the same name in another application
      mask: hiding("EMP-2"),
      settingsKey: "lf-b",
      processor: () => ownB,
    });

    const attributes = {
      [WORKFLOW_ATTRIBUTE]: "desk-workflow",
      "langfuse.observation.input": "TCK-1 EMP-2",
    };
    const rootA = started(router, attributes, a);
    const childA = started(router, attributes, undefined, rootA); // a child: its parent's route
    const rootB = started(router, attributes, b);
    childA.end();
    rootA.end();
    rootB.end();
    await router.forceFlush();

    expect(ownA.ended.map((span) => span.attributes["langfuse.observation.input"])).toEqual([
      "<TCK-1> EMP-2",
      "<TCK-1> EMP-2",
    ]);
    expect(ownB.ended.map((span) => span.attributes["langfuse.observation.input"])).toEqual([
      "TCK-1 <EMP-2>",
    ]);
  });

  it("R8: a span of no route goes only to the one processor, masked by every route's; with two, nowhere", async () => {
    const router = new TraceRouter();
    const ownA = new KeptSpans();
    const ownB = new KeptSpans();
    const base = { workflow: "w", settingsKey: "lf-a", processor: () => ownA };
    router.addRoute({ ...base, owner: {}, mask: hiding("TCK-1") });
    router.addRoute({ ...base, owner: {}, mask: hiding("EMP-2") });

    const alone = started(router, { "langfuse.observation.input": "TCK-1 EMP-2" });
    expect((await endedOn(router, alone, ownA))?.attributes["langfuse.observation.input"]).toBe(
      "<TCK-1> <EMP-2>",
    );
    router.addRoute({ owner: {}, workflow: "w", settingsKey: "lf-b", processor: () => ownB });
    const nowhere = started(router, { "langfuse.observation.input": "TCK-1" });
    nowhere.end();
    await router.forceFlush();

    expect(ownA.ended).toHaveLength(1);
    expect(ownB.ended).toEqual([]);
  });

  it("R9: Langfuse's process-wide provider stays the masking one until the last tracing shuts down", async () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-1130",
      LANGFUSE_SECRET_KEY: "sk-lf-1130",
      LANGFUSE_BASE_URL: "http://127.0.0.1:9",
    };
    const owner = {};
    const first = langfuseTracing(env, hiding("TCK-1"), { workflow: "ticket-workflow", owner });
    const provider = getLangfuseTracerProvider();
    const second = langfuseTracing(env, undefined, { workflow: "refund-workflow", owner });

    expect(getLangfuseTracerProvider()).toBe(provider);
    await first?.shutdown();
    expect(getLangfuseTracerProvider()).toBe(provider);
    await second?.shutdown();
    expect(getLangfuseTracerProvider()).not.toBe(provider);
  });
});

/** One application: a root that lists a policy, its child that lists another. */
const chainApplication = () => {
  const processor = new KeptSpans();
  const router = new TraceRouter();
  const owner = {};
  const add = (workflow: string, mask?: TraceMask) =>
    router.addRoute({ owner, workflow, mask, settingsKey: "lf", processor: () => processor });
  const root = add("root-workflow", hiding("ROOT-1"));
  add("child-workflow", hiding("CHILD-2"));
  add("other-workflow", hiding("OTHER-3"));
  return { router, processor, root };
};

describe("#1150: a child's spans are masked by its chain", () => {
  it("AC3: a span of a child is masked by every workflow of its chain — never by another's", async () => {
    const { router, processor, root } = chainApplication();

    const span = started(
      router,
      {
        [WORKFLOW_ATTRIBUTE]: "child-workflow",
        [WORKFLOW_CHAIN_ATTRIBUTE]: '["root-workflow","child-workflow"]',
        "langfuse.observation.input": "ROOT-1 CHILD-2 OTHER-3",
      },
      root,
    );
    const ended = await endedOn(router, span, processor);

    expect(ended?.attributes["langfuse.observation.input"]).toBe("<ROOT-1> <CHILD-2> OTHER-3");
  });

  it("AC3: a chain naming a workflow of no route masks by the application's every route (fail closed)", async () => {
    const { router, processor, root } = chainApplication();

    const span = started(
      router,
      {
        [WORKFLOW_ATTRIBUTE]: "child-workflow",
        [WORKFLOW_CHAIN_ATTRIBUTE]: '["gone-workflow","child-workflow"]',
        "langfuse.observation.input": "ROOT-1 CHILD-2 OTHER-3",
      },
      root,
    );
    const ended = await endedOn(router, span, processor);

    expect(ended?.attributes["langfuse.observation.input"]).toBe("<ROOT-1> <CHILD-2> <OTHER-3>");
  });

  it("AC3: an unreadable chain masks by the application's every route (fail closed)", async () => {
    const { router, processor, root } = chainApplication();

    const span = started(
      router,
      {
        [WORKFLOW_ATTRIBUTE]: "child-workflow",
        [WORKFLOW_CHAIN_ATTRIBUTE]: "not json",
        "langfuse.observation.input": "ROOT-1 CHILD-2",
      },
      root,
    );
    const ended = await endedOn(router, span, processor);

    expect(ended?.attributes["langfuse.observation.input"]).toBe("<ROOT-1> <CHILD-2>");
  });
});
