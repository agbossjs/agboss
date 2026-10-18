import { Text } from "../../../src/dto/index.js";

/** DTOs of the #263 examples (with `CompanyDto` of `data-dtos.ts`). */

export class CompanyLinkDto {
  @Text({ prompt: "a link to the company's page" })
  url!: string;
}

export class PromisingCompanyDto {
  @Text({ prompt: "why the company looks promising" })
  reason!: string;
}

export class DeepDiveDto {
  @Text({ prompt: "what the deep dive found" })
  findings!: string;
}

export class CompanyGradeDto {
  @Text({ prompt: "how well the company fits" })
  grade!: string;
}

export class CompanyRejectedDto {
  @Text({ prompt: "why the company is not a fit" })
  reason!: string;
}

export class CompanyReviewFailedDto {
  @Text({ prompt: "why the company could not be reviewed" })
  reason!: string;
}

export class GradedShortlistDto {
  @Text({ prompt: "the companies, best first" })
  order!: string;
}

export class JobOfferDto {
  @Text({ prompt: "the offer" })
  text!: string;
}
