import { Tool, type ToolHandler } from "@agboss/core";
import { ResumeReader } from "../services/resume-reader.service.js";
import { ResumeRequest, ResumeText } from "./read-resume.dto.js";

/** Reads the user's resume (PDF, Markdown, text). */
@Tool({
  name: "read-resume-tool",
  description:
    "Read the user's resume from a local file (.pdf, .md or .txt). Pass the path exactly as the user gave it.",
  input: ResumeRequest,
  output: ResumeText,
  deps: [ResumeReader],
})
export class ReadResume implements ToolHandler<ResumeRequest, ResumeText> {
  constructor(private readonly reader: ResumeReader) {}

  run({ path }: ResumeRequest): Promise<ResumeText> {
    return this.reader.read(path);
  }
}
