import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, EmptyEnvironment, Tool, Workflow, inline, Ttl } from "../../../src/index.js";
import { WorkflowFinish, WorkflowStart } from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Rag,
  RagQueryDto,
  RagScope,
  RagSearchResultsDto,
  SqliteFtsRagSource,
} from "../../../src/rag/index.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #700 AC1 — two tenants, each its own folder of documents on one SQLite FTS index: tenant B's
 * vault code is in B's folder only. One agent searches (through a `@Tool` that injects the knowledge base), one is given the results first
 * (`rag: [...]`).
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

@Rag({
  name: "tenant-docs-rag",
  description: "The tenant's own documents",
  scope: RagScope.Tenant,
  topK: 3,
})
export class TenantDocsRag extends SqliteFtsRagSource {
  constructor() {
    super({
      directory: ({ tenantId }) => (tenantId === undefined ? undefined : FOLDERS.get(tenantId)),
      path: join(root, "index", "docs.sqlite"),
    });
  }
}

@Tool({
  name: "search-tenant-docs",
  description: "Searches the tenant's documents",
  input: RagQueryDto,
  output: RagSearchResultsDto,
  readOnly: true,
  deps: [TenantDocsRag],
})
export class SearchTenantDocsTool {
  constructor(private readonly docs: TenantDocsRag) {}

  execute({ query }: RagQueryDto): Promise<RagSearchResultsDto> {
    return this.docs.search(query);
  }
}

@Agent({
  name: "searching-agent",
  description: "Searches the tenant's documents",
  prompt: inline("Answer from the documents."),
  model: "local/llama",
  tools: [SearchTenantDocsTool],
})
export class SearchingAgent {}

@Agent({
  name: "reading-agent",
  description: "Reads the tenant's documents given first",
  prompt: inline("Answer from the documents."),
  model: "local/llama",
  rag: [TenantDocsRag],
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
const PROVIDERS = [TenantDocsRag, SearchTenantDocsTool];

@Workflow({
  name: "search-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(SearchStart).toAgent(SearchingAgent).toFinish(SearchFinish)],
  defaults: DEFAULTS,
  providers: PROVIDERS,
})
export class SearchWorkflow {}

@Workflow({
  name: "read-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ReadStart).toAgent(ReadingAgent).toFinish(ReadFinish)],
  defaults: DEFAULTS,
  providers: PROVIDERS,
})
export class ReadWorkflow {}

@Application({
  name: "tenant-docs-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SearchWorkflow, ReadWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class TenantDocsApplication {}
