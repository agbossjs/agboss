import { Agent } from "@agboss/core";
import { ReadResume } from "../tools/read-resume.tool.js";
import { KIMI } from "../config/settings.js";

@Agent({
  name: "profiler-agent",
  promptUrls: ["./profiler.prompt.md"],
  description:
    "Reads the user's resume, interviews them about the jobs they want and agrees a search brief",
  model: KIMI,
  // a ceiling: a model stuck in a repetition loop stops here instead of generating for minutes
  maxTokens: 2000,
  tools: [ReadResume],
})
export class ProfilerAgent {}
