import { Flag, Integer, Text } from "../../../src/dto/index.js";

/** DTOs of the #279 examples (with `CompanyDto` of `data-dtos.ts`, `CompanyCheckDto` of `launch-dtos.ts`). */

export class CandidateDto {
  @Text({ prompt: "the candidate" })
  name!: string;
}

export class ScoreDto {
  @Integer({ prompt: "the score, 1–10" })
  score!: number;
}

export class ScoreReviewDto {
  @Text({ prompt: "the review of the counted scores" })
  text!: string;
}

export class SkillsScoreDto {
  @Integer({ prompt: "the technical skills, 1–10" })
  score!: number;
}

export class CultureScoreDto {
  @Integer({ prompt: "the culture fit, 1–10" })
  score!: number;
}

export class SalaryFitDto {
  @Flag({ prompt: "whether the salary fits" })
  fits!: boolean;
}

export class FitSummaryDto {
  @Text({ prompt: "the fit, summed up" })
  text!: string;
}

export class CompanyShortlistDto {
  @Text({ prompt: "the shortlisted companies" })
  companies!: string;
}

export class DealDto {
  @Text({ prompt: "the deal" })
  name!: string;
}

export class LegalReviewDto {
  @Text({ prompt: "the legal risks found" })
  risks!: string;
}

export class DealCritiqueDto {
  @Text({ prompt: "an objection" })
  objection!: string;
}

export class AuditDto {
  @Flag({ prompt: "whether the audit passed" })
  passed!: boolean;
}

export class FastScreenDto {
  @Flag({ prompt: "whether the deal is rejected at once" })
  rejected!: boolean;
}

export class DueDiligenceReportDto {
  @Text({ prompt: "the due diligence report" })
  text!: string;
}
