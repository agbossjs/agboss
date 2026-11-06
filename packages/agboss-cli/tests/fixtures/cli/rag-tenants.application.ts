// `agboss rag index` fixture (#797): the notes' knowledge bases in an application that declares a
// tenant context — more than one tenant exists, so the command names the one it builds
import { Application, EmptyEnvironment, TenantContext } from "../../../../agboss/src/index.js";
import { OneOf } from "../../../../agboss/src/dto/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { NotesWorkflow } from "./rag.workflow.js";

export class NotesTenantContext extends TenantContext {
  @OneOf({ values: ["free", "pro"] })
  plan!: "free" | "pro";
}

@Application({
  name: "tenant-notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NotesWorkflow],
  tenantContext: NotesTenantContext,
  budgets: TEST_BUDGETS,
})
export class TenantNotesApplication {}
