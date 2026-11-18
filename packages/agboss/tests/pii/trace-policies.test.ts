/**
 * #1130: everything observed of a run — its exported spans, its observer events, its record — is
 * masked by the PII policies of THAT run's workflow and its application, never by another
 * workflow's (whichever the application built last); what belongs to no one run (the application's
 * own log) by the union of every workflow's (fail closed).
 */
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppWith } from "../../src/application/create-app.js";
import { Application } from "../../src/application/application.js";
import type { AgentStartEvent } from "../../src/core/observability.js";
import { Injectable, type OnAgentStart } from "../../src/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { replyWith, routeTo } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import {
  ContactPiiPolicy,
  OpenStart,
  OpenWorkflow,
  PII_KEY_VARIABLE,
  PiiStart,
  PiiWorkflow,
} from "./pii.fixture.js";
import { requestText } from "./boundary.helpers.js";
import { WORKFLOW_ATTRIBUTE, WORKFLOW_CHAIN_ATTRIBUTE } from "../../src/tracing/trace-router.js";
import {
  CHILD_SECRET,
  ChainApplication,
  ChainChildAgent,
  ChainFarRootStart,
  ChainOpenRootStart,
  ChainRootStart,
  ROOT_SECRET,
  TEXT,
} from "./chain.fixture.js";

/** What every Langfuse span processor of the process exported (kept past its shutdown). */
const exported = vi.hoisted(() => ({
  spans: [] as ReadableSpan[],
  byKey: new Map<string, ReadableSpan[]>(),
  processors: 0,
}));

vi.mock("@langfuse/otel", async (original) => {
  const real = await original<typeof import("@langfuse/otel")>();
  const { InMemorySpanExporter: Memory } = await import("@opentelemetry/sdk-trace-base");
  /** An in-memory exporter whose spans go to `exported.spans` as they are exported. */
  class KeepingExporter extends Memory {
    constructor(private readonly publicKey: string) {
      super();
    }
    override export(...args: Parameters<InMemorySpanExporter["export"]>): void {
      exported.spans.push(...args[0]);
      const own = exported.byKey.get(this.publicKey) ?? [];
      exported.byKey.set(this.publicKey, [...own, ...args[0]]);
      super.export(...args);
    }
  }
  class RecordedProcessor extends real.LangfuseSpanProcessor {
    constructor(params: ConstructorParameters<typeof real.LangfuseSpanProcessor>[0]) {
      exported.processors += 1;
      const exporter = new KeepingExporter(params?.publicKey ?? "");
      super({ ...params, exporter, exportMode: "immediate" });
    }
  }
  return { ...real, LangfuseSpanProcessor: RecordedProcessor };
});

/** A value only pii-workflow's own policy (`employee-id-pii-policy`) masks. */
const EMPLOYEE_ID = "EMP-0042";

const LANGFUSE = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-1130",
  LANGFUSE_SECRET_KEY: "sk-lf-1130",
  LANGFUSE_BASE_URL: "http://127.0.0.1:9",
};

/** Every agent input an observer saw. */
const seen: string[] = [];

/** Sees each agent's input, then breaks with a value of its own: the application's log has it. */
@Injectable()
class BreakingObserver implements OnAgentStart {
  onAgentStart(event: AgentStartEvent): void {
    seen.push(event.input);
    throw new Error(`observer broke on ${EMPLOYEE_ID}`);
  }
}

/** pii-workflow lists `EmployeeIdPiiPolicy`; open-workflow, built after it, lists none. */
@Application({
  name: "trace-policies-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PiiWorkflow, OpenWorkflow],
  piiPolicies: [ContactPiiPolicy],
  observers: [BreakingObserver],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
class TracePoliciesApplication {}

/** A second application of the process: open-workflow alone, its own Langfuse project. */
@Application({
  name: "other-tracing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OpenWorkflow],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
class OtherTracingApplication {}

const OTHER_LANGFUSE = {
  ...LANGFUSE,
  LANGFUSE_PUBLIC_KEY: "pk-lf-other",
  [PII_KEY_VARIABLE]: "test-key",
};

const appOf = (book: ScriptBook) =>
  createAppWith(TracePoliciesApplication, {
    processEnv: { ...LANGFUSE, [PII_KEY_VARIABLE]: "test-key" },
    gateway: createScriptedGateway(book),
  });

/** The workflow names on the spans one Langfuse project received. */
const workflowsAt = (publicKey: string): string[] => [
  ...new Set(
    (exported.byKey.get(publicKey) ?? []).flatMap((span) => {
      const name = span.attributes["langfuse.observation.metadata.workflowName"];
      return typeof name === "string" ? [name] : [];
    }),
  ),
];

/** What the application's log said of the observer's failure. */
const observerFailures = (): string =>
  logged
    .filter((entry) => entry.code === "observer.failed")
    .map((entry) => entry.message)
    .join("\n");

const spans = (): readonly ReadableSpan[] => exported.spans;

/** Every attribute value of every exported span, as text. */
const exportedText = (): string =>
  spans()
    .map((span) => JSON.stringify(span.attributes))
    .join("\n");

afterEach(() => {
  seen.length = 0;
  resetLogged();
  exported.spans.length = 0;
  exported.byKey.clear();
  exported.processors = 0;
});

describe("#1130: a run is observed through its own workflow's policies", () => {
  it("AC1 spans: a run of the workflow with the policy exports no raw value — another workflow lacks it", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith(`checked ${EMPLOYEE_ID}`));
    const app = await appOf(book);

    const result = await execute(app, PiiStart, { text: `about ${EMPLOYEE_ID}` }, { record: true });
    await app.close();

    expect(result.output).toEqual({ text: `checked ${EMPLOYEE_ID}` });
    expect(spans().length).toBeGreaterThan(3);
    expect(exportedText()).toContain("<employee-id>");
    expect(exportedText()).not.toContain(EMPLOYEE_ID);
  });

  it("AC1 events and record: masked by the run's workflow, whatever the other lists", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith(`checked ${EMPLOYEE_ID}`));
    const app = await appOf(book);

    const result = await execute(app, PiiStart, { text: `about ${EMPLOYEE_ID}` }, { record: true });
    await app.close();

    expect(seen.join("\n")).toContain("<employee-id>");
    expect(seen.join("\n")).not.toContain(EMPLOYEE_ID);
    expect(JSON.stringify(result.record)).not.toContain(EMPLOYEE_ID);
  });

  it("AC2: a run of the workflow without the policy is not masked by the other's", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:open-agent").thenReturn(replyWith("ok"));
    const app = await appOf(book);

    await execute(app, OpenStart, { text: `about ${EMPLOYEE_ID}` });
    await app.close();

    expect(spans().length).toBeGreaterThan(3);
    expect(exportedText()).toContain(EMPLOYEE_ID);
    expect(seen.join("\n")).toContain(EMPLOYEE_ID);
  });

  it("AC3 logs: the application's own log masks with every workflow's policies (fail closed)", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:open-agent").thenReturn(replyWith("ok"));
    const app = await appOf(book);

    await execute(app, OpenStart, { text: "hello" });
    await app.close();

    expect(observerFailures()).toContain("observer broke on <employee-id>");
    expect(observerFailures()).not.toContain(EMPLOYEE_ID);
  });

  it("AC4: two applications in one process — each run's spans reach only its own Langfuse, masked by its own policies", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith(`checked ${EMPLOYEE_ID}`));
    book.scriptOf("agent:open-agent").thenReturn(replyWith("ok"));
    const app = await appOf(book);
    const other = await createAppWith(OtherTracingApplication, {
      processEnv: OTHER_LANGFUSE,
      gateway: createScriptedGateway(book),
    });

    await execute(app, PiiStart, { text: `about ${EMPLOYEE_ID}` });
    await execute(other, OpenStart, { text: "hello" });
    await other.close();
    await app.close();

    expect(workflowsAt(LANGFUSE.LANGFUSE_PUBLIC_KEY)).toEqual(["pii-workflow"]);
    expect(workflowsAt(OTHER_LANGFUSE.LANGFUSE_PUBLIC_KEY)).toEqual(["open-workflow"]);
    expect(exportedText()).not.toContain(EMPLOYEE_ID);
  });
});

/** The spans of one workflow (by its `workflowName`), as text. */
const spansOf = (workflow: string): string =>
  spans()
    .filter((span) => span.attributes["langfuse.observation.metadata.workflowName"] === workflow)
    .map((span) => JSON.stringify(span.attributes))
    .join("\n");

const chainAppOf = (book: ScriptBook) =>
  createAppWith(ChainApplication, {
    processEnv: { ...LANGFUSE, [PII_KEY_VARIABLE]: "test-key" },
    gateway: createScriptedGateway(book),
  });

describe("#1150: a child's spans are masked by its chain", () => {
  it("AC3 spans: a child in its parent's step — its spans by the root's and its own policies; the root's by its own only", async () => {
    const book = new ScriptBook();
    book.scriptOf("router:chain-child-router").thenReturn(routeTo(ChainChildAgent));
    book.scriptOf("agent:chain-child-agent").thenReturn(replyWith(`done ${CHILD_SECRET}`));
    const app = await chainAppOf(book);

    await execute(app, ChainRootStart, { text: TEXT });
    await app.close();

    const child = spansOf("chain-child-workflow");
    expect(child).toContain("chain-child-agent");
    expect(child).not.toContain(ROOT_SECRET);
    expect(child).not.toContain(CHILD_SECRET);
    // the root's own spans: masked by its own chain — the child's policy is not the root's
    expect(spansOf("chain-root-workflow")).not.toContain(ROOT_SECRET);
    expect(spansOf("chain-root-workflow")).toContain(CHILD_SECRET);
  });

  it("AC4 spans: an AnyInstance child's spans name the child and its chain (bug 1) — never the root's mask alone", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:chain-far-agent").thenReturn(replyWith(`done ${CHILD_SECRET}`));
    const app = await chainAppOf(book);

    await execute(app, ChainFarRootStart, { text: TEXT });
    await app.close();

    const child = spansOf("chain-far-workflow");
    expect(child).toContain("chain-far-agent");
    const chains = spans()
      .filter((span) => span.attributes[WORKFLOW_ATTRIBUTE] === "chain-far-workflow")
      .map((span) => span.attributes[WORKFLOW_CHAIN_ATTRIBUTE]);
    expect(new Set(chains)).toEqual(new Set(['["chain-root-workflow","chain-far-workflow"]']));
    expect(child).not.toContain(ROOT_SECRET);
    expect(child).not.toContain(CHILD_SECRET);
  });

  it("AC2 spans: an exclusion never reaches the traces — the agent's model saw the value, its spans never", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:chain-open-agent").thenReturn(replyWith("done"));
    const app = await chainAppOf(book);

    await execute(app, ChainOpenRootStart, { text: TEXT });
    await app.close();

    expect(requestText(book.scriptOf("agent:chain-open-agent").onlyRequest)).toContain(ROOT_SECRET);
    expect(spansOf("chain-open-workflow")).toContain("chain-open-agent");
    expect(spansOf("chain-open-workflow")).not.toContain(ROOT_SECRET);
  });
});
