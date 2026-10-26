import { Flag, OneOf, Text } from "@agboss/core/dto";

/** Which resume to read. */
export class ResumeRequest {
  @Text({ prompt: "the path exactly as the user gave it", minLength: 1 })
  path!: string;
}

/** The resume's text, and where it was read from. */
export class ResumeText {
  @Text({ prompt: "the file that was read" })
  path!: string;

  @Text({ prompt: "the path asked for, when a near match was read instead", optional: true })
  requestedPath?: string;

  @OneOf({ values: ["pdf", "markdown", "text"] })
  format!: "pdf" | "markdown" | "text";

  @Text() text!: string;

  @Flag({ prompt: "true when the text was cut to fit" })
  truncated!: boolean;
}
