import { A2AEndpoint } from "@agboss/core/a2a";
import { hours, minutes } from "@agboss/core/units";
import { DeskWorkflowStart } from "../workflows/desk/desk.workflow-start.js";

/**
 * What `desk-application` serves over A2A (#398 PR 3, #808): its one start — the one skill of its
 * Agent Card. `agboss describe --json` lists it under `contracts.exports`; a change to its input
 * or its finishes' outputs needs a new `version` (`check --federation` against
 * `snapshots/desk-application.json`).
 */
@A2AEndpoint({
  name: "desk-a2a-expose",
  version: "1.0.0",
  description: "Answers order questions for the helpline",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [{ start: DeskWorkflowStart, tags: ["orders", "support"] }], // a card's skill is found by its tags
})
export class DeskA2AExpose {}
