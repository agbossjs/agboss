import { Text } from "@agboss/core/dto";

/** The user's shortlist as saved (empty when nothing is saved yet). */
export class ShortlistContent {
  @Text({ prompt: "the shortlist, in Markdown" })
  content!: string;
}
