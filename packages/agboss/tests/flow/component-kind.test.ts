/**
 * #1324 (Q-G): one `ComponentKind` for every component. Each value is the exact kebab-case name of
 * the decorator (the suffix of the component's `name`); what an execution record, a lease or an error
 * routes on stores that string, and no reader accepts the 0.1.0 spellings (`"question"`,
 * `"reply-interpreter"`).
 */
import { describe, expect, it } from "vitest";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import * as flow from "../../src/public/flow.js";

const KINDS: Readonly<Record<keyof typeof ComponentKind, string>> = {
  Application: "application",
  Workflow: "workflow",
  WorkflowStart: "workflow-start",
  WorkflowFinish: "workflow-finish",
  Agent: "agent",
  Action: "action",
  Router: "router",
  Arbiter: "arbiter",
  Tool: "tool",
  ToolInterceptor: "tool-interceptor",
  ToolApproval: "tool-approval",
  ExternalTask: "external-task",
  Channel: "channel",
  ChannelSelector: "channel-selector",
  WorkingCalendar: "working-calendar",
  ChannelListener: "channel-listener",
  ChannelInterpreter: "channel-interpreter",
  Memory: "memory",
  Rag: "rag",
  RagReranker: "rag-reranker",
  Guardrail: "guardrail",
  Injectable: "injectable",
  PiiPolicy: "pii-policy",
  FilePolicy: "file-policy",
  FileMasker: "file-masker",
  FileTranscriber: "file-transcriber",
  Judge: "judge",
  EvalSuite: "eval-suite",
  Budget: "budget",
  ModelProvider: "model-provider",
  DatabaseStorage: "database-storage",
  ClusterStorage: "cluster-storage",
  ObjectStorage: "object-storage",
  Mesh: "mesh",
  HttpAuthenticator: "http-authenticator",
  Observer: "observer",
  HealthCheck: "health-check",
  McpServer: "mcp-server",
  McpEndpoint: "mcp-endpoint",
  A2AAgent: "a2a-agent",
  A2AEndpoint: "a2a-endpoint",
};

describe("#1324: ComponentKind is one enum of 41 kebab-case kinds", () => {
  it("has exactly the 41 kinds, each the kebab-case name of its decorator", () => {
    expect({ ...ComponentKind }).toEqual(KINDS);
    expect(Object.keys(ComponentKind)).toHaveLength(41);
  });

  it("has no two kinds with the same string, and every string is kebab-case", () => {
    const values = Object.values(ComponentKind);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("does not know the 0.1.0 spellings (a hard break, no legacy reader)", () => {
    const values: readonly string[] = Object.values(ComponentKind);
    expect(values).not.toContain("question");
    expect(values).not.toContain("reply-interpreter");
    expect(values).toContain("external-task");
    expect(values).toContain("channel-interpreter");
    expect(values).toContain("tool-approval");
  });

  it("stores the new string in a component record, as JSON", () => {
    const record = bareRecordOf("approver-external-task", ComponentKind.ExternalTask);
    expect(record.kind).toBe("external-task");
    expect(JSON.parse(JSON.stringify(record))).toMatchObject({ kind: "external-task" });
  });

  it("is the only kind enum: the flow entry point exports no NodeKind", () => {
    expect(flow).toHaveProperty("ComponentKind");
    expect(flow).not.toHaveProperty("NodeKind");
    expect(flow).not.toHaveProperty("FlowNodeKind");
  });
});
