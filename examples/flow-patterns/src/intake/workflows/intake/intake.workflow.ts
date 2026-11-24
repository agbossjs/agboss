import { group, onStart, Workflow } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { FastScreenAgent } from "../../agents/fast-screen/fast-screen.agent.js";
import { LegalCheckAgent } from "../../agents/legal-check/legal-check.agent.js";
import { IntakeReportWorkflowFinish } from "./intake-report.workflow-finish.js";
import { QuickScreenWorkflowFinish } from "./quick-screen.workflow-finish.js";
import { IntakeWorkflowStart } from "./intake.workflow-start.js";

/**
 * A quorum by groups (#279): a full legal check and a quick screen side by side; the first group
 * complete by priority goes on its own path — the full check (priority 1) when it answers, else
 * the quick screen. The rest is cancelled.
 */
@Workflow({
  name: "intake-workflow",
  version: "1.0.0",
  flow: [
    onStart(IntakeWorkflowStart)
      .toParallelAgents(LegalCheckAgent, FastScreenAgent)
      .joinQuorumGroups(
        group(LegalCheckAgent)
          .priority(1)
          .toFinish(IntakeReportWorkflowFinish),
        group(FastScreenAgent)
          .priority(2)
          .toFinish(QuickScreenWorkflowFinish),
        { deadline: seconds(30) },
      ),
  ],
})
export class IntakeWorkflow {}
