import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/environments/empty.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  RemoteItemWorkflow,
  RemoteOneWorkflow,
} from "../../../flow/runtime/fixtures/remote-children.workflow.js";

/** A parent that launches one child (`RemoteItemWorkflow`), both declaring no placement: the profiles place the child. */
@Application({
  name: "placement-config-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteOneWorkflow],
  budgets: TEST_BUDGETS,
})
export class PlacementApplication {}

export { RemoteItemWorkflow as PlacedChildWorkflow, RemoteOneWorkflow as PlacedParentWorkflow };
