import { Agent } from "@agboss/core";
import { CandidateDto } from "../../../panel/dto/candidate.dto.js";
import { FastScreenDto } from "../../dto/intake.dto.js";

/** The fast branch: a one-line screen of the candidate. */
@Agent({
  name: "fast-screen-agent",
  description: "Screens the candidate in one line",
  prompt: "Say in one line whether the candidate fits the role.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: FastScreenDto,
})
export class FastScreenAgent {}
