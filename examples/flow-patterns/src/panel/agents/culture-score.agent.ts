import { Agent } from "@agboss/core";
import { CandidateDto } from "../dtos/candidate.dto.js";
import { ScoreDto } from "../dtos/score.dto.js";

/** A panelist: scores the culture fit. */
@Agent({
  name: "culture-score-agent",
  description: "Scores the culture fit",
  promptUrls: ["./culture-score.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class CultureScoreAgent {}
