import { Text } from "@agboss/core/dto";

/** What the second wave reviews: the sections that need work, from the first wave's reviews. */
export class EditorialPlanDto {
  @Text({ prompt: "the sections to rework, comma-separated" })
  rework!: string;

  @Text({ prompt: "the sections that are ready, comma-separated" })
  ready!: string;
}
