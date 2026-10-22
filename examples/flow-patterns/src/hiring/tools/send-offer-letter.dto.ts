import { Text } from "agboss/dto";

/** A letter to send: the question its approval is about (`approves`). */
export class LetterDelivery {
  @Text({ prompt: "the letter's text, exactly as written" })
  text!: string;
}

/** The sent letter: the tool ran, so the recruiter approved it. */
export class LetterDelivered {
  @Text({ prompt: "the id of the sent letter" })
  messageId!: string;
}
