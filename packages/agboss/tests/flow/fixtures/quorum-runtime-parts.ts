import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Integer } from "../../../src/dto/index.js";
import {
  Agent,
  Arbiter,
  Clock,
  DecidedBy,
  ExecutionContext,
  listOf,
  OnAnswer,
  Tool,
  WorkflowFinish,
  WorkflowStart,
  type OnQuorumDecided,
  type QuorumDecidedEvent,
  type ToolHandler,
} from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  CandidateDto,
  DealCritiqueDto,
  DealDto,
  DueDiligenceReportDto,
  FastScreenDto,
  LegalReviewDto,
  ScoreDto,
  ScoreReviewDto,
} from "./quorum-dtos.js";

/**
 * #279 PR 2 — the components of the runtime's quorums (`quorum-runtime.fixture.ts` wires them): three
 * panel agents that may wait on the test's clock (`wait_tool`) or for an approval
 * (`confirm_score`), arbiters by code and by model, the deal's reviewers for the groups, and a log
 * of `onQuorumDecided`. `panel` is the test's view of what happened.
 */

/** What the panel did: the waits in progress, the arbiters' calls, the decided quorums, the gate. */
export const panel: {
  waiting: number;
  readonly woken: (() => void)[];
  readonly checks: string[];
  readonly decided: QuorumDecidedEvent[];
  gate: Promise<void>;
  openGate: () => void;
} = {
  waiting: 0,
  woken: [],
  checks: [],
  decided: [],
  gate: Promise.resolve(),
  openGate: () => undefined,
};

/** A fresh panel for every test; the gate closed. */
export function resetPanel(): void {
  panel.waiting = 0;
  panel.woken.length = 0;
  panel.checks.length = 0;
  panel.decided.length = 0;
  panel.gate = new Promise((resolve) => {
    panel.openGate = resolve;
  });
}

/** Resolves once `count` waits are in progress on the clock. */
export function untilWaiting(count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (panel.waiting >= count) resolve();
      else panel.woken.push(check);
    };
    check();
  });
}

/** A model request's input as text. */
export const textOf = (request: { readonly input: unknown } | undefined): string =>
  typeof request?.input === "string" ? request.input : JSON.stringify(request?.input ?? "");

/** Resolves once an arbiter has started `check` (`in-range hire 99`). */
export async function untilChecked(check: string): Promise<void> {
  while (!panel.checks.includes(check))
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
}

export class WaitDto {
  @Integer({ prompt: "how many seconds to wait" })
  seconds!: number;
}

/** Waits on the application's clock — until the time passes or the execution stops. */
@Tool({
  name: "wait_tool",
  description: "Waits",
  timeoutMs: 3_600_000, // an hour: longer than any wait of the tests
  input: WaitDto,
  output: WaitDto,
  deps: [Clock, ExecutionContext],
})
export class WaitTool implements ToolHandler<WaitDto, WaitDto> {
  constructor(
    private readonly clock: Clock,
    private readonly executionContext: ExecutionContext,
  ) {}

  async run(input: WaitDto): Promise<WaitDto> {
    panel.waiting += 1;
    for (const wake of panel.woken.splice(0)) wake();
    await this.clock.sleep(seconds(input.seconds), this.executionContext.signal);
    panel.waiting -= 1;
    return input;
  }
}

/** Every call waits for an approval. */
@Tool({
  name: "confirm_score",
  description: "Confirms a score",
  channel: TerminalUserChannel,
  input: ScoreDto,
  output: ScoreDto,
})
export class ConfirmScoreTool implements ToolHandler<ScoreDto, ScoreDto> {
  run(input: ScoreDto): Promise<ScoreDto> {
    return Promise.resolve(input);
  }
}

const MODEL = "moonshotai/kimi-k2.6";
const TOOLS = [WaitTool, ConfirmScoreTool];

@WorkflowStart({ name: "panel-workflow-start", description: "A candidate", input: CandidateDto })
export class PanelWorkflowStart {}

@WorkflowStart({
  name: "panel-items-workflow-start",
  description: "The candidates",
  input: listOf(CandidateDto),
})
export class PanelItemsWorkflowStart {}

@Agent({
  name: "skills-panel-agent",
  description: "Scores the skills",
  prompt: "Score the skills.",
  model: MODEL,
  tools: TOOLS,
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class SkillsPanelAgent {}

@Agent({
  name: "risks-panel-agent",
  description: "Scores the risks",
  prompt: "Score the risks.",
  model: MODEL,
  tools: TOOLS,
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class RisksPanelAgent {}

@Agent({
  name: "hire-panel-agent",
  description: "Scores the hire",
  prompt: "Score the hire.",
  model: MODEL,
  tools: TOOLS,
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class HirePanelAgent {}

@Agent({
  name: "panel-summary-agent",
  description: "Sums up the counted scores",
  prompt: "Sum up the scores.",
  model: MODEL,
  input: { scores: listOf(ScoreDto) },
  output: ScoreReviewDto,
})
export class PanelSummaryAgent {}

@WorkflowFinish({
  name: "panel-review-workflow-finish",
  description: "The review",
  output: ScoreReviewDto,
})
export class PanelReviewWorkflowFinish {}

@WorkflowFinish({
  name: "panel-failed-workflow-finish",
  description: "No quorum: the candidate, for a person",
  output: CandidateDto,
})
export class PanelFailedWorkflowFinish {}

@WorkflowFinish({
  name: "panel-unjudged-workflow-finish",
  description: "An arbiter failed: the candidate, for a person",
  output: CandidateDto,
})
export class PanelUnjudgedWorkflowFinish {}

/** A score from 1 to 10 counts; 13 breaks the check; 99 waits for the gate, then counts. */
async function inRange(node: string, answer: ScoreDto): Promise<boolean> {
  panel.checks.push(`in-range ${node} ${String(answer.score)}`);
  if (answer.score === 13) throw new Error("thirteen is not a score");
  if (answer.score === 99) await panel.gate;
  return answer.score === 99 || (answer.score >= 1 && answer.score <= 10);
}

@Arbiter({ name: "in-range-arbiter", decidedBy: DecidedBy.Code })
export class InRangeArbiter {
  @OnAnswer(SkillsPanelAgent)
  fromSkillsPanel(answer: ScoreDto): Promise<boolean> {
    return inRange("skills", answer);
  }

  @OnAnswer(RisksPanelAgent)
  fromRisksPanel(answer: ScoreDto): Promise<boolean> {
    return inRange("risks", answer);
  }

  @OnAnswer(HirePanelAgent)
  fromHirePanel(answer: ScoreDto): Promise<boolean> {
    return inRange("hire", answer);
  }
}

@Arbiter({
  name: "panel-model-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: SkillsPanelAgent, prompt: "Scores the technical skills" },
    { agent: RisksPanelAgent, prompt: "Names a concrete risk" },
    { agent: HirePanelAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class PanelModelArbiter {}

/** Per item: only the even items count — the item from `executionContext.step.itemIndex`. */
@Arbiter({ name: "even-item-arbiter", decidedBy: DecidedBy.Code, deps: [ExecutionContext] })
export class EvenItemArbiter {
  constructor(private readonly executionContext: ExecutionContext) {}

  @OnAnswer(SkillsPanelAgent)
  fromSkillsPanel(answer: ScoreDto): boolean {
    const { itemIndex, nodeId } = this.executionContext.step;
    panel.checks.push(`even-item ${nodeId}[${String(itemIndex)}] ${String(answer.score)}`);
    return (itemIndex ?? 1) % 2 === 0;
  }
}

/** Copies: the second copy never counts — the copy from `executionContext.step.copyNumber`. */
@Arbiter({ name: "copy-arbiter", decidedBy: DecidedBy.Code, deps: [ExecutionContext] })
export class CopyArbiter {
  constructor(private readonly executionContext: ExecutionContext) {}

  @OnAnswer(SkillsPanelAgent)
  fromSkillsPanel(): boolean {
    const { copyNumber, nodeId } = this.executionContext.step;
    panel.checks.push(`copy ${nodeId} ${String(copyNumber)}`);
    return copyNumber !== 2;
  }
}

// ── the deal's reviewers: groups ──

@WorkflowStart({ name: "deal-panel-workflow-start", description: "A deal", input: DealDto })
export class DealPanelWorkflowStart {}

@Agent({
  name: "legal-panel-agent",
  description: "Reviews the legal risks",
  prompt: "Review the legal risks.",
  model: MODEL,
  tools: [WaitTool],
  input: { deal: DealDto },
  output: LegalReviewDto,
})
export class LegalPanelAgent {}

@Agent({
  name: "critic-panel-agent",
  description: "Objects",
  prompt: "Object.",
  model: MODEL,
  tools: [WaitTool],
  input: { deal: DealDto },
  output: DealCritiqueDto,
})
export class CriticPanelAgent {}

@Agent({
  name: "fast-panel-agent",
  description: "Screens the deal fast",
  prompt: "Screen the deal.",
  model: MODEL,
  tools: [WaitTool],
  input: { deal: DealDto },
  output: FastScreenDto,
})
export class FastPanelAgent {}

@Agent({
  name: "deal-report-panel-agent",
  description: "Writes the report from the counted reviews",
  prompt: "Write the report.",
  model: MODEL,
  input: { legal: LegalReviewDto, critique: DealCritiqueDto },
  output: DueDiligenceReportDto,
})
export class DealReportPanelAgent {}

@WorkflowFinish({
  name: "deal-report-panel-workflow-finish",
  description: "The report",
  output: DueDiligenceReportDto,
})
export class DealReportPanelWorkflowFinish {}

@WorkflowFinish({
  name: "second-opinion-panel-workflow-finish",
  description: "The critique alone",
  output: DealCritiqueDto,
})
export class SecondOpinionPanelWorkflowFinish {}

@WorkflowFinish({
  name: "quick-reject-panel-workflow-finish",
  description: "The fast screen",
  output: FastScreenDto,
})
export class QuickRejectPanelWorkflowFinish {}

@WorkflowFinish({
  name: "no-quorum-panel-workflow-finish",
  description: "No group complete: the deal, for a person",
  output: DealDto,
})
export class NoQuorumPanelWorkflowFinish {}

@Injectable()
export class QuorumLog implements OnQuorumDecided {
  onQuorumDecided(event: QuorumDecidedEvent): void {
    panel.decided.push(event);
  }
}
