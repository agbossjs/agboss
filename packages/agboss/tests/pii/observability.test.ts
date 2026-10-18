/** #120 AC7: logs, traces, events and the record are masked by the application's lists. */
import { describe, expect, it } from "vitest";
import {
  Injectable,
  PiiAction,
  type OnAgentStart,
  type OnModelStart,
  type OnToolEnd,
  type OnToolStart,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import type {
  AgentStartEvent,
  ModelStartEvent,
  ToolEndEvent,
  ToolStartEvent,
} from "../../src/core/observability.js";
import { Application } from "../../src/application/application.js";
import { createApp } from "../../src/application/create-app.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TenantContext } from "../../src/flow/context/tenant-context.js";
import { observabilityMaskOf } from "../../src/pii/observability-mask.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { requestText } from "./boundary.helpers.js";
import {
  ContactPiiPolicy,
  GovernmentPiiPolicy,
  OpenStart,
  OpenWorkflow,
  PII_KEY_VARIABLE,
  PiiStart,
  PiiWorkflow,
  SendEmail,
} from "./pii.fixture.js";

const EMAIL = "alice@example.com";

/** Every event the observers saw, as text. */
const seen: string[] = [];

@Injectable()
class SeeingObserver implements OnAgentStart, OnToolStart, OnToolEnd, OnModelStart {
  onAgentStart(event: AgentStartEvent): void {
    seen.push(event.input);
  }
  onToolStart(event: ToolStartEvent): void {
    seen.push(JSON.stringify(event.arguments));
  }
  onToolEnd(event: ToolEndEvent): void {
    seen.push(event.update);
  }
  onModelStart(event: ModelStartEvent): void {
    seen.push(event.rawPayload.map((message) => JSON.stringify(message.content)).join(" "));
    throw new Error(`observer broke on ${EMAIL}`);
  }
}

@Application({
  name: "seen-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PiiWorkflow, OpenWorkflow],
  piiPolicies: [ContactPiiPolicy, GovernmentPiiPolicy],
  observers: [SeeingObserver],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
class SeenApplication {}

async function seenApp(book: ScriptBook) {
  return createApp(SeenApplication, {
    processEnv: { [PII_KEY_VARIABLE]: "test-key" },
    gateway: createScriptedGateway(book),
  });
}

describe("#120 AC7: observability is masked by the whole list", () => {
  it("events, the log and the record never show the raw values — the tool still got them", async () => {
    seen.length = 0;
    resetLogged();
    const book = new ScriptBook();
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(SendEmail, { to: EMAIL, body: "hi" }), replyWith(`wrote ${EMAIL}`));
    const app = await seenApp(book);

    const result = await execute(app, PiiStart, { text: `to ${EMAIL}` }, { record: true });

    expect(seen.length).toBeGreaterThan(3);
    expect(seen.join("\n")).not.toContain(EMAIL);
    expect(seen.join("\n")).toContain("<email:");
    const warnings = logged.filter((entry) => entry.code === "observer.failed");
    expect(warnings.map((entry) => entry.message).join("\n")).toContain(
      "observer broke on <email:",
    );
    expect(JSON.stringify(result.record)).not.toContain(EMAIL);
    expect(result.output).toEqual({ text: `wrote ${EMAIL}` });
    await app.close();
  });

  it("exclude… touches only the agent's model: its events stay masked", async () => {
    seen.length = 0;
    const book = new ScriptBook();
    book.scriptOf("agent:open-agent").thenReturn(replyWith("ok"));
    const app = await seenApp(book);

    await execute(app, OpenStart, { text: `to ${EMAIL}` });

    expect(requestText(book.scriptOf("agent:open-agent").onlyRequest)).toContain(EMAIL);
    expect(seen.join("\n")).not.toContain(EMAIL);
    await app.close();
  });
});

class ShopTenantContext extends TenantContext {
  @Text({ sensitive: PiiAction.replaceWithKind() })
  owner!: string;
}

describe("#120 AC7: a trace's spans", () => {
  const mask = observabilityMaskOf(new PiiPolicySet([], "k"), {
    tenantContext: ShopTenantContext,
    executionContext: ShopTenantContext,
  });

  it("hides the execution's PII channels and sensitive context fields in a state", async () => {
    const state = {
      piiTokens: { "<email:aaaaaa>": EMAIL },
      piiValues: [{ value: "Dana", label: "owner", action: PiiAction.replaceWithKind() }],
      contexts: { tenant: { tenantId: "acme", owner: "Dana" }, execution: {} },
    };
    const shown = await mask.traceData(JSON.stringify(state));
    expect(shown).not.toContain(EMAIL);
    expect(shown).not.toContain("Dana");
    expect(JSON.parse(String(shown))).toMatchObject({
      piiTokens: { "<email:aaaaaa>": "<email>" },
      contexts: { tenant: { tenantId: "acme", owner: "<owner>" } },
    });
  });

  it("keeps text that is not JSON, and values that are not text", async () => {
    expect(await mask.traceData("plain text")).toBe("plain text");
    expect(await mask.traceData({ piiTokens: { "<x:abcdef>": "v" } })).toEqual({
      piiTokens: { "<x:abcdef>": "<x>" },
    });
    expect(mask.text("a line")).toBe("a line");
  });
});
