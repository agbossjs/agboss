import { Agent } from "@agboss/core";
import { CandidateDto } from "../../../panel/dto/candidate.dto.js";
import { LegalReviewDto } from "../../dto/intake.dto.js";

/** The slow, thorough branch: checks the candidate's paperwork. */
@Agent({
  name: "legal-check-agent",
  description: "Checks the candidate's paperwork",
  prompt: "Check the candidate's paperwork: work permit, references, notice period.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: LegalReviewDto,
})
export class LegalCheckAgent {}
