import { Integer, ListOf, Text } from "@agboss/core/dto";

/** One job the user chose, copied from the list shown. */
export class ChosenJob {
  @Text() title!: string;
  @Text() company!: string;
  @Text() location!: string;

  @Text({ prompt: "the job's link, exactly as in the list" })
  link!: string;

  @Integer({ prompt: "the fit shown in the list, %", min: 0, max: 100, optional: true })
  fit?: number;
}

/** The jobs to add to the shortlist. */
export class ChosenJobs {
  @ListOf(ChosenJob, { prompt: "the jobs the user chose, copied from the list shown", minItems: 1 })
  jobs!: ChosenJob[];
}

/** What was added and what was there already (by title). */
export class SavedJobs {
  @ListOf(Text) added!: string[];
  @ListOf(Text) alreadyThere!: string[];
}
