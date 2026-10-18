import { Agent } from "agboss";
import { CandidateDto } from "../dtos/candidate.dto.js";
import { ScoreDto } from "../dtos/score.dto.js";

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
