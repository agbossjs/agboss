import { Agent } from "@agboss/core";
import { CandidateDto } from "../dtos/candidate.dto.js";
import { ScoreDto } from "../dtos/score.dto.js";

/** A panelist: scores the technical skills. */
@Agent({
  name: "skills-score-agent",
  description: "Scores the technical skills",
  promptUrls: ["./skills-score.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: ScoreDto,
})
export class SkillsScoreAgent {}
