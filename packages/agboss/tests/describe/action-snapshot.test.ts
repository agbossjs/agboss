import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { describeApplication } from "../../src/describe/describe-application.js";
import { describeServices } from "../../src/describe/describe-workflow.js";
import { workflowSnapshotOf } from "../../src/describe/snapshot.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { EmptyEnvironment } from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  BookTripAction,
  BookingDto,
  CancelBookingAction,
  ConfirmTripAction,
  TripBookedWorkflowFinish,
  TripConfirmedDto,
  TripNotBookedWorkflowFinish,
  TripRequestDto,
  TripWorkflowStart,
} from "../flow/fixtures/compensation-parts.js";
import { start, toAction } from "../flow/fixtures/paths.js";

/**
 * #339 AC4 — `agboss describe` prints each action's `compensateWith` / `committedBy`, and
 * `describe --json` carries them on the action's node (`ActionSnapshot`); an action without them
 * has none, and a workflow without them no `actions` section.
 */

@Workflow({
  name: "booking-workflow",
  version: "1.0.0",
  flow: [
    start(TripWorkflowStart)
      .returns(TripRequestDto)
      .toAction(BookTripAction)
      .returns(BookingDto)
      .toAction(ConfirmTripAction)
      .onError(StepFailedError, toAction(CancelBookingAction).toFinish(TripNotBookedWorkflowFinish))
      .returns(TripConfirmedDto)
      .toFinish(TripBookedWorkflowFinish),
  ],
})
class BookingWorkflow {}

@Application({
  name: "booking-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BookingWorkflow],
  budgets: TEST_BUDGETS,
})
class BookingApplication {}

const assembled = await applicationOf(BookingApplication);
const [booking] = assembled.workflows;
if (booking === undefined) throw new TypeError("the application lists one workflow");

describe("#339 AC4: describe shows declared compensation", () => {
  it("the text: one line per action that declares it", () => {
    const lines = describeApplication(assembled);

    expect(lines).toContain(
      "  book-trip-action  compensateWith cancel-booking-action · committedBy confirm-trip-action",
    );
    expect(lines.filter((line) => line.includes("compensateWith"))).toHaveLength(1);
  });

  it("the JSON: an ActionSnapshot on the action's node, none on the others", () => {
    const { nodes } = workflowSnapshotOf(booking, describeServices);

    expect(nodes.find((node) => node.name === "book-trip-action")?.action).toEqual({
      compensateWith: "cancel-booking-action",
      committedBy: "confirm-trip-action",
    });
    expect(nodes.find((node) => node.name === "confirm-trip-action")).not.toHaveProperty("action");
  });
});
