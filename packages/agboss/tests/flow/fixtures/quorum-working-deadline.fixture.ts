import {
  Arbiter,
  Arbitrate,
  Channel,
  ChannelOutcome,
  EmptyEnvironment,
  ExternalTask,
  Injectable,
  PauseRespondent,
  QuorumNotReachedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  WorkingCalendar,
  type ChannelAsk,
  type WorkingCalendarContext,
  type WorkingCalendarHandler, Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { PauseError } from "../../../src/core/error-families/pause-errors.js";
import { onStart, toAction, toExternalTask, toFinish } from "../../../src/flow/builder.js";
import { workDays, workHours, days } from "../../../src/units/index.js";
import { TEL_AVIV } from "../../calendar/helpers.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import {
  ContractDto,
  DraftContractAction,
  SignContractAction,
  SignOffDto,
  SignedDto,
  ContractRejectedWorkflowFinish,
  ContractSignedWorkflowFinish,
} from "./committee.fixture.js";

/**
 * #1306 — a committee's quorum with a deadline in working time: `deadline: workHours(2)` /
 * `workDays(1)` counted by the quorum's own `@WorkingCalendar`. Tel Aviv's office is Sunday to
 * Thursday 09:00–18:00 (lunch 13:00–14:00), and the calendars are the quorum's, not the
 * application's. `BrokenWorkingCalendar` cannot answer: its failure is `PauseError.WorkingCalendar`.
 */

/** Tel Aviv's office, as a declarative grid. */
@WorkingCalendar({ name: "office-working-calendar", week: TEL_AVIV })
export class OfficeWorkingCalendar {}

/** What the broken calendar was asked, across a test. */
@Injectable()
export class CalendarLog {
  readonly asked: WorkingCalendarContext[] = [];
}

/** A calendar that cannot answer (its holiday table is down). */
@WorkingCalendar({ name: "broken-working-calendar", deps: [CalendarLog] })
export class BrokenWorkingCalendar implements WorkingCalendarHandler {
  constructor(private readonly log: CalendarLog) {}

  addWorkingTime(request: WorkingCalendarContext): Date {
    this.log.asked.push(request);
    throw new Error("the holiday table is down");
  }
}

/** The pauses' own deadline is long: the quorum's is the one that bounds them. */
@ExternalTask({
  name: "auditor-external-task",
  description: "The auditor signs off",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: days(30),
})
export class AuditorExternalTask {}

@ExternalTask({
  name: "counsel-external-task",
  description: "The counsel signs off",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: days(30),
})
export class CounselExternalTask {}

@Channel({
  name: "auditor-inbox-channel",
  description: "The auditor's inbox",
  target: AuditorExternalTask,
  ttl: days(60),
})
export class AuditorInboxChannel {
  send(_ask: ChannelAsk<AuditorExternalTask>): ChannelOutcome<AuditorExternalTask> {
    return ChannelOutcome.awaitReply();
  }
}

@Channel({
  name: "counsel-inbox-channel",
  description: "The counsel's inbox",
  target: CounselExternalTask,
  ttl: days(60),
})
export class CounselInboxChannel {
  send(_ask: ChannelAsk<CounselExternalTask>): ChannelOutcome<CounselExternalTask> {
    return ChannelOutcome.awaitReply();
  }
}

@Arbiter({ name: "audit-sign-off-arbiter" })
export class AuditSignOffArbiter {
  @Arbitrate(AuditorExternalTask, CounselExternalTask)
  isApproved(answer: SignOffDto): boolean {
    return answer.approved;
  }
}

@WorkflowStart({
  name: "audit-hours-workflow-start",
  description: "The contract",
  input: WorkflowStartTextDto,
})
export class AuditHoursWorkflowStart {}

@WorkflowStart({
  name: "audit-days-workflow-start",
  description: "The contract",
  input: WorkflowStartTextDto,
})
export class AuditDaysWorkflowStart {}

@WorkflowStart({
  name: "audit-groups-workflow-start",
  description: "The contract",
  input: WorkflowStartTextDto,
})
export class AuditGroupsWorkflowStart {}

@WorkflowStart({
  name: "audit-broken-workflow-start",
  description: "The contract",
  input: WorkflowStartTextDto,
})
export class AuditBrokenWorkflowStart {}

@WorkflowStart({
  name: "audit-unhandled-workflow-start",
  description: "The contract",
  input: WorkflowStartTextDto,
})
export class AuditUnhandledWorkflowStart {}

const parties = [toExternalTask(AuditorExternalTask), toExternalTask(CounselExternalTask)] as const;

/** One approval is enough, within 2 working hours. */
@Workflow({
  name: "audit-hours-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AuditHoursWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([...parties])
      .arbitratedBy(AuditSignOffArbiter)
      .joinQuorum({ min: 1, deadline: workHours(2), calendar: OfficeWorkingCalendar })
      .onError(QuorumNotReachedError, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class AuditHoursWorkflow {}

/** One approval is enough, within a working day. */
@Workflow({
  name: "audit-days-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AuditDaysWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([...parties])
      .arbitratedBy(AuditSignOffArbiter)
      .joinQuorum({ min: 1, deadline: workDays(1), calendar: OfficeWorkingCalendar })
      .onError(QuorumNotReachedError, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class AuditDaysWorkflow {}

/** Groups: the auditor alone, within 2 working hours. */
@Workflow({
  name: "audit-groups-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AuditGroupsWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([...parties])
      .arbitratedBy(AuditSignOffArbiter)
      .joinQuorumGroups({ deadline: workHours(2), calendar: OfficeWorkingCalendar })
      .onError(QuorumNotReachedError, toFinish(ContractRejectedWorkflowFinish))
      .onGroup(
        [AuditorExternalTask],
        toAction(SignContractAction)
          .toFinish(ContractSignedWorkflowFinish),
      ),
  ],
})
export class AuditGroupsWorkflow {}

/** The calendar fails: the join's handler takes `PauseError.WorkingCalendar`. */
@Workflow({
  name: "audit-broken-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AuditBrokenWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([...parties])
      .arbitratedBy(AuditSignOffArbiter)
      .joinQuorum({ min: 1, deadline: workDays(2), calendar: BrokenWorkingCalendar })
      .onError(PauseError.WorkingCalendar, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class AuditBrokenWorkflow {}

/** The calendar fails and nothing handles it: the execution fails with the error. */
@Workflow({
  name: "audit-unhandled-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(AuditUnhandledWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([...parties])
      .arbitratedBy(AuditSignOffArbiter)
      .joinQuorum({ min: 1, deadline: workDays(2), calendar: BrokenWorkingCalendar })
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class AuditUnhandledWorkflow {}

@Application({
  name: "audit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    AuditHoursWorkflow,
    AuditDaysWorkflow,
    AuditGroupsWorkflow,
    AuditBrokenWorkflow,
    AuditUnhandledWorkflow,
  ],
  providers: [CalendarLog],
  channels: [AuditorInboxChannel, CounselInboxChannel],
  budgets: TEST_BUDGETS,
})
export class AuditApplication {}

export { SignedDto };
