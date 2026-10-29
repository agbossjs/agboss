import { A2AExpose } from "@agboss/core/a2a";
import { DeskWorkflowStart } from "../workflows/desk/desk.workflow-start.js";

/**
 * What `desk-application` serves over A2A (#398 PR 3): its one start. `agboss describe --json`
 * lists it under `contracts.exports`; a change to its input or its finishes' outputs needs a new
 * `version` (`check --federation` against `snapshots/desk-application.json`).
 */
@A2AExpose({ name: "desk-a2a-expose", version: "1.0.0", exports: [DeskWorkflowStart] })
export class DeskA2AExpose {}
