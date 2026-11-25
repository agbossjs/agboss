import { PauseRespondent, ToolApproval } from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";

/**
 * The approval of a test tool that waits for its owner (#1324): no `@Channel` serves it, so the run
 * pauses and the test answers with `app.resume({ pauseId, decision: { approved } })`.
 */
@ToolApproval({
  name: "owner-tool-approval",
  description: "The thread's owner approves the tool call",
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class OwnerToolApproval {}
