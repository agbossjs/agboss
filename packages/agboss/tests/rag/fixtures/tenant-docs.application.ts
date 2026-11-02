import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, EmptyEnvironment, InjectionToken, provide, Workflow } from "../../../src/index.js";
import { WorkflowFinish, WorkflowStart } from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { Rag, RagMode, SqliteFtsConnector, type FtsOptions } from "../../../src/rag/index.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * #700 AC1 — two tenants, each its own folder of documents on one SQLite FTS index: tenant B's
 * vault code is in B's folder only. One agent searches (tool mode), one is given the results first
 * (context mode).
 */

const root = mkdtempSync(join(tmpdir(), "rag-tenants-"));
const FOLDERS: ReadonlyMap<string, string> = new Map([
  ["tenant-a", join(root, "a")],
  ["tenant-b", join(root, "b")],
]);
mkdirSync(join(root, "a"));
mkdirSync(join(root, "b"));
writeFileSync(join(root, "a", "hours.md"), "# Hours\n\nThe office opens at nine every morning.");
writeFileSync(join(root, "b", "vault.md"), "# Vault\n\nThe vault code is plum seventeen.");

export const TENANT_DOCS = new InjectionToken<FtsOptions>("TENANT_DOCS");

@Rag({
  name: "tenant-docs-rag",
  description: "The tenant's own documents",
  topK: 3,
  deps: [TENANT_DOCS],
})
export class TenantDocsRag extends SqliteFtsConnector {}

@Agent({
  name: "searching-agent",
  description: "Searches the tenant's documents",
  prompt: "Answer from the documents.",
  model: "local/llama",
  rag: [{ use: TenantDocsRag, mode: RagMode.Tool }],
})
export class SearchingAgent {}

@Agent({
  name: "reading-agent",
  description: "Reads the tenant's documents given first",
  prompt: "Answer from the documents.",
  model: "local/llama",
  rag: [{ use: TenantDocsRag, mode: RagMode.Context }],
})
export class ReadingAgent {}

@WorkflowStart({
  name: "search-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class SearchStart {}

@WorkflowStart({
  name: "read-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class ReadStart {}

@WorkflowFinish({
  name: "search-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class SearchFinish {}

@WorkflowFinish({
  name: "read-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ReadFinish {}

const DEFAULTS = { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } } as const;
const PROVIDERS = [
  provide(TENANT_DOCS, {
    folder: (tenantId: string) => FOLDERS.get(tenantId),
    dbFile: join(root, "index", "docs.sqlite"),
  }),
];

@Workflow({
  name: "search-workflow",
  version: "1.0.0",
  flow: [
    start(SearchStart).returns(WorkflowStartTextDto).toAgent(SearchingAgent).toFinish(SearchFinish),
  ],
  defaults: DEFAULTS,
  providers: PROVIDERS,
})
export class SearchWorkflow {}

@Workflow({
  name: "read-workflow",
  version: "1.0.0",
  flow: [start(ReadStart).returns(WorkflowStartTextDto).toAgent(ReadingAgent).toFinish(ReadFinish)],
  defaults: DEFAULTS,
  providers: PROVIDERS,
})
export class ReadWorkflow {}

@Application({
  name: "tenant-docs-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SearchWorkflow, ReadWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class TenantDocsApplication {}
