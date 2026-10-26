import { Text } from "@agboss/core/dto";

/** `read_text_file` of the filesystem server: which file. */
export class FileRead {
  @Text({ prompt: "path inside the shortlist folder" })
  path!: string;
}

/** `read_text_file`: the file's text. */
export class FileContent {
  @Text({ prompt: "the file's text" })
  content!: string;
}

/** `write_file`: which file and its whole new content. */
export class FileWrite {
  @Text({ prompt: "path inside the shortlist folder" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

/** `write_file`: what the server reported. */
export class FileWritten {
  @Text({ prompt: "what the server reported" })
  content!: string;
}
