import { Agent, listOf } from "agboss";
import { PanelReviewDto } from "../dtos/panel-review.dto.js";
import { ScoreDto } from "../dtos/score.dto.js";

/** Sums up the scores the quorum counted — never one it left out. */
@Agent({
  name: "score-summary-agent",
  description: "Sums up the counted scores",
  promptUrls: ["./score-summary.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { scores: listOf(ScoreDto) },
  output: PanelReviewDto,
})
export class ScoreSummaryAgent {}
