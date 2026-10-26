import { Text } from "@agboss/core/dto";

/**
 * What the helpline sends the desk — its own class: `check --federation` compares it with the
 * desk's `DeskQuestionDto` field by field, never by name.
 */
export class DeskCallDto {
  @Text({ prompt: "the customer's id" })
  customerId!: string;

  @Text({ prompt: "the customer's question, naming the order as #<id>" })
  question!: string;
}

/** What the desk answers: the text of its finish. */
export class DeskReplyDto {
  @Text({ prompt: "the desk's answer" })
  text!: string;
}
