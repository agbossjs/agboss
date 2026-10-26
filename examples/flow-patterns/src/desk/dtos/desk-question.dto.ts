import { Text } from "@agboss/core/dto";

/** A customer's question to the help desk. */
export class DeskQuestionDto {
  @Text({ prompt: "who asks" })
  customerId!: string;

  @Text({ prompt: "the question, naming the order as #<id>" })
  question!: string;
}
