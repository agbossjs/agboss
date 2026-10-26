import { OneOf, Text } from "@agboss/core/dto";

/** `read_text_file` of the filesystem server: which file. */
export class PolicyFileRead {
  @Text({ prompt: "the file's path inside the policies folder" })
  path!: string;
}

/** `read_text_file`: the file's text. */
export class PolicyFileContent {
  @Text({ prompt: "the policy's text" })
  content!: string;
}

/** What the helpline's model asks for: one policy by its topic. */
export class PolicyTopic {
  @OneOf({ values: ["returns", "shipping"], prompt: "the policy to read" })
  topic!: "returns" | "shipping";
}
