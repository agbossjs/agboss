/**
 * #1313, #1318, #1324: every framework decorator refuses a key it does not take — given as a JS caller or
 * a spread of an untyped variable gives it — and names the option and the decorator, never the value.
 * One row per decorator; the families are the infrastructure, the pause targets and channels, and the
 * components that tune a model, a file or a policy.
 */
import { describe, expect, it } from "vitest";
import { unknownOptionViolations } from "../../src/application/unknown-option-rules.js";
import type { Class } from "../../src/components/injection.js";
import { Arbiter } from "../../src/flow/decorators/arbiter.js";
import { Router } from "../../src/flow/decorators/router.js";
import * as framework from "../../src/index.js";
import { A2AAgent } from "../../src/a2a/a2a-decorator.js";
import { A2AEndpoint } from "../../src/a2a/a2a-endpoint.decorator.js";
import { EvalSuite } from "../../src/eval/suite/eval-suite.decorator.js";
import { McpEndpoint } from "../../src/mcp/mcp-endpoint.decorator.js";
import { Mesh } from "../../src/mesh/mesh.decorator.js";
import { ModelProvider } from "../../src/models/model-provider.decorator.js";
import { OpenAiCompatibleDriver } from "../../src/models/index.js";
import { PiiPolicy } from "../../src/pii/pii-policy.decorator.js";
import { RagReranker } from "../../src/rag/reranker.decorator.js";
import { WorkingCalendar } from "../../src/calendar/working-calendar.js";
import {
  ClusterStorage,
  DatabaseStorage,
  ObjectStorage,
} from "../../src/storage/storage-decorators.js";
import { ChannelListener } from "../../src/pause/channel-listener.js";
import { ChannelSelector } from "../../src/channels/channel-selector.js";
import { ChannelInterpreter } from "../../src/channels/channel-interpreter.js";
import { ExternalTask, ToolApproval } from "../../src/channels/pause-targets.js";
import { HttpAuthenticator } from "../../src/http/http-authenticator.js";
import { FilePolicy } from "../../src/files/file-policy.js";
import { HealthCheck } from "../../src/health/health-check.js";
import { McpServer, Rag } from "../../src/components/decorators.js";
import { Judge } from "../../src/components/judge-decorators.js";
import { OutputGuardrail } from "../../src/components/policy-decorators.js";

const SECRET = "sk-live-do-not-print";

type Decorate = (options: never) => (value: Class) => unknown;

/** A decorator as a JS caller calls it: the options are whatever it is given. */
const asLoose = (decorator: unknown): Decorate => decorator as Decorate;

interface Row {
  readonly decorator: string;
  readonly apply: Decorate;
  /** The options the decorator takes without complaint, so only the stray key is wrong. */
  readonly base: Readonly<Record<string, unknown>>;
}

const rows: readonly Row[] = [
  {
    decorator: "ModelProvider",
    apply: asLoose(ModelProvider),
    base: { driver: OpenAiCompatibleDriver({ baseUrl: "http://x.test/v1" }) },
  },
  { decorator: "Mesh", apply: asLoose(Mesh), base: {} },
  { decorator: "DatabaseStorage", apply: asLoose(DatabaseStorage), base: {} },
  { decorator: "ClusterStorage", apply: asLoose(ClusterStorage), base: {} },
  { decorator: "ObjectStorage", apply: asLoose(ObjectStorage), base: {} },
  { decorator: "HttpAuthenticator", apply: asLoose(HttpAuthenticator), base: {} },
  { decorator: "McpEndpoint", apply: asLoose(McpEndpoint), base: {} },
  { decorator: "A2AEndpoint", apply: asLoose(A2AEndpoint), base: {} },
  { decorator: "McpServer", apply: asLoose(McpServer), base: {} },
  { decorator: "A2AAgent", apply: asLoose(A2AAgent), base: {} },
  { decorator: "ToolApproval", apply: asLoose(ToolApproval), base: { name: "n" } },
  { decorator: "ExternalTask", apply: asLoose(ExternalTask), base: { name: "n" } },
  { decorator: "Channel", apply: asLoose(framework.Channel), base: {} },
  { decorator: "ChannelSelector", apply: asLoose(ChannelSelector), base: {} },
  { decorator: "ChannelListener", apply: asLoose(ChannelListener), base: {} },
  { decorator: "ChannelInterpreter", apply: asLoose(ChannelInterpreter), base: {} },
  { decorator: "Observer", apply: asLoose(framework.Observer), base: {} },
  { decorator: "HealthCheck", apply: asLoose(HealthCheck), base: {} },
  { decorator: "WorkingCalendar", apply: asLoose(WorkingCalendar), base: {} },
  { decorator: "EvalSuite", apply: asLoose(EvalSuite), base: { cases: [] } },
  { decorator: "FilePolicy", apply: asLoose(FilePolicy), base: {} },
  { decorator: "PiiPolicy", apply: asLoose(PiiPolicy), base: {} },
  { decorator: "RagReranker", apply: asLoose(RagReranker), base: {} },
  { decorator: "Rag", apply: asLoose(Rag), base: {} },
  { decorator: "Judge", apply: asLoose(Judge), base: {} },
  { decorator: "Arbiter", apply: asLoose(Arbiter), base: {} },
  { decorator: "Router", apply: asLoose(Router), base: {} },
  { decorator: "OutputGuardrail", apply: asLoose(OutputGuardrail), base: {} },
];

/** What a decorator refuses to do with options of its own is not the rule's business: the key is recorded first. */
function declared(row: Row, options: Readonly<Record<string, unknown>>): Class {
  const target = class Target {
    readonly isTarget = true;
  };
  try {
    row.apply(options as never)(target);
  } catch {
    // another rule (a respondent, a form) may refuse the options; the stray key was recorded before it
  }
  return target;
}

describe("[decorator.unknown-option]: every decorator", () => {
  it.each(rows)("$decorator names a stray option and itself, not its value", (row) => {
    const target = declared(row, { ...row.base, strayOption: SECRET });

    const found = unknownOptionViolations([target]);

    expect(found.map((one) => one.code)).toEqual(["decorator.unknown-option"]);
    expect(found[0]?.message).toContain(`strayOption is not an option of @${row.decorator}`);
    expect(found[0]?.message).not.toContain(SECRET);
  });

  it.each(rows)("$decorator finds it behind a spread, and ignores one that is undefined", (row) => {
    const shared = { ...row.base, strayOption: SECRET };
    const spread = declared(row, { ...shared });
    const unset = declared(row, { ...row.base, strayOption: undefined });

    expect(unknownOptionViolations([spread])).toHaveLength(1);
    expect(unknownOptionViolations([unset])).toEqual([]);
  });
});

describe("[decorator.unknown-option]: a typo of a protective option", () => {
  it("suggests piiPolicies for piiPolicy, and toolInterceptors for toolInterceptor", () => {
    @framework.Agent({
      name: "typo-agent",
      description: "d",
      piiPolicy: [],
      toolInterceptor: [],
    } as never)
    class Typo {}

    expect(unknownOptionViolations([Typo]).map((one) => one.message)).toEqual([
      "Typo: piiPolicy is not an option of @Agent — did you mean piiPolicies?",
      "Typo: toolInterceptor is not an option of @Agent — did you mean toolInterceptors?",
    ]);
  });
});
