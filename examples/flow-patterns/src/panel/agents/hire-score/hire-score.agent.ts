import { Agent } from "@agboss/core";
import { CandidateDto } from "../../dto/candidate.dto.js";
import { ScoreDto } from "../../dto/score.dto.js";

/** A panelist: scores the hire decision. */
@Agent({
  name: "hire-score-agent",
  description: "Scores the hire decision",
  promptUrls: ["./hire-score.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class HireScoreAgent {}
