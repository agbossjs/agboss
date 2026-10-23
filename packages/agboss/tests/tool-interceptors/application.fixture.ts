/**
 * The #384 test application: two workflows — a scout whose agent calls every tool, and a quiet
 * one whose agent excludes the application's interceptor — with tool interceptors on all four
 * levels, a PII policy and a small bound on tool results.
 */
import {
  Agent,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { kilobytes } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import {
  AuditToolInterceptor,
  BoardLookupTool,
  CompanyTool,
  JobBoardServer,
  JobScoutTenantContext,
  JobSearchTool,
  MoodyToolInterceptor,
  PingTool,
  TenantScopeToolInterceptor,
} from "./components.fixture.js";

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides email addresses from models",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
})
export class ContactPiiPolicy {}

@WorkflowStart({ name: "scout-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class ScoutStart {}

@WorkflowFinish({
  name: "scout-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ScoutAnswer {}

@Agent({
  name: "scout-agent",
  description: "Searches jobs and companies",
  prompt: "Help with the job search.",
  model: "test/scout",
  tools: [JobSearchTool, CompanyTool, BoardLookupTool, PingTool],
  toolInterceptors: [MoodyToolInterceptor],
})
export class ScoutAgent {}

@Workflow({
  name: "scout-workflow",
  version: "1.0.0",
  flow: [start(ScoutStart).returns(WorkflowStartTextDto).toAgent(ScoutAgent).toFinish(ScoutAnswer)],
  toolInterceptors: [TenantScopeToolInterceptor],
  mcp: [JobBoardServer],
  defaults: { tools: { maxResultSize: kilobytes(1) } },
})
export class ScoutWorkflow {}

@WorkflowStart({ name: "quiet-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class QuietStart {}

@WorkflowFinish({
  name: "quiet-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class QuietAnswer {}

/** No audit for its calls: it removes the application's interceptor. */
@Agent({
  name: "quiet-agent",
  description: "Searches without an audit",
  prompt: "Search quietly.",
  model: "test/quiet",
  tools: [JobSearchTool, CompanyTool],
  excludeToolInterceptors: [AuditToolInterceptor],
})
export class QuietAgent {}

@Workflow({
  name: "quiet-workflow",
  version: "1.0.0",
  flow: [start(QuietStart).returns(WorkflowStartTextDto).toAgent(QuietAgent).toFinish(QuietAnswer)],
})
export class QuietWorkflow {}

@Application({
  name: "scout-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ScoutWorkflow, QuietWorkflow],
  tenantContext: JobScoutTenantContext,
  piiPolicies: [ContactPiiPolicy],
  toolInterceptors: [AuditToolInterceptor],
  budgets: TEST_BUDGETS,
})
export class ScoutApplication {}
