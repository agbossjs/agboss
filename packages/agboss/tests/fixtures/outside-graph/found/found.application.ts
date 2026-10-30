import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { FoundProbeWorkflow } from "./found.workflow.js";

/** #497: the application of found.workflow.ts, found by `workflowOf` next to it. */
@Application({
  name: "found-probe-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FoundProbeWorkflow],
  defaults: { models: { temperature: 0.25 } },
  budgets: TEST_BUDGETS,
})
export class FoundProbeApplication {}
