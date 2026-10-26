import { Agent } from "@agboss/core";
import { Reasoning, ReasoningEffort } from "@agboss/core/models";
import { ReadShortlist } from "../mcp/read-shortlist.mcp.js";
import { SaveShortlist } from "../mcp/save-shortlist.mcp.js";
import { KIMI } from "../config/settings.js";

@Agent({
  name: "shortlist-agent",
  promptUrls: ["./shortlist.prompt.md"],
  description: "Saves the jobs the user chooses to their shortlist file and shows what is on it",
  model: KIMI,
  // a ceiling: a model stuck in a repetition loop stops here instead of generating for minutes
  maxTokens: 1000,
  // matching "save 3" to the list needs a little care
  reasoning: Reasoning.on({ effort: ReasoningEffort.Low }),
  tools: [ReadShortlist, SaveShortlist],
})
export class ShortlistAgent {}
