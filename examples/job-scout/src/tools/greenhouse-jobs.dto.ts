import { Decimal, Integer, ListOf, Text } from "@agboss/core/dto";

/** What the user wants from a job search — what the model fills in. */
export class JobQuery {
  @Text({
    prompt:
      "What the user wants: role, primary languages, specialization, seniority, deal-breakers",
    minLength: 20,
  })
  profile!: string;

  @ListOf(Text, {
    prompt: "Places or cities; a configured place (e.g. a country) also matches its cities",
    minItems: 1,
  })
  locations!: string[];

  @ListOf(Text, {
    prompt:
      "Keep only jobs whose title has any of these words, e.g. Senior — applied before the judge",
    default: [],
  })
  titleMustInclude!: string[];

  @ListOf(Text, { prompt: "Drop jobs whose title has any, e.g. Team Lead, Manager", default: [] })
  excludeTitleWords!: string[];

  @ListOf(Text, { prompt: "Skills from the resume — shown as matched skills", default: [] })
  skills!: string[];

  @ListOf(Text, { prompt: "Board tokens; empty = all configured boards", default: [] })
  boards!: string[];

  @Integer({ prompt: "How many jobs to return", min: 1, max: 50, default: 20 })
  count!: number;

  @Decimal({
    prompt:
      "Optional floor on the judge's P(fit); 0 = rank only (the judge ranks well, its probabilities are compressed)",
    min: 0,
    max: 1,
    default: 0,
  })
  minFit!: number;
}

/** One job found, with its fit (%) and the resume skills it mentions. */
export class FoundJob {
  @Text() company!: string;
  @Text() title!: string;
  @Text() location!: string;
  @Text() department!: string;
  @Text() url!: string;
  @Text() updated!: string;
  @Integer() fit!: number;
  @ListOf(Text) matchedSkills!: string[];
}

/** A board that could not be read, and why. */
export class FailedBoard {
  @Text() board!: string;
  @Text() error!: string;
}

/** The best jobs for a query, and how the search went. */
export class JobMatches {
  @ListOf(Text) searched!: string[];
  @ListOf(FailedBoard) failedBoards!: FailedBoard[];
  @Integer() afterFilters!: number;
  @Integer() judged!: number;
  @Integer() judgeFailures!: number;
  @Integer() passed!: number;
  @ListOf(FoundJob) jobs!: FoundJob[];
}
