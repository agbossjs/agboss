import { Compaction, CompactionStrategy } from "@agboss/core";
import { KIMI } from "../config/settings.js";

/**
 * How the job-scout conversation keeps what is older than its readers' window (#120 PR 3): every 5
 * turns past the window become one self-contained summary; the latest 10 are kept.
 */
@Compaction({
  name: "conversation-compaction",
  description: "Summarises old turns of the job-scout conversation",
  promptUrls: ["./conversation.prompt.md"],
  model: KIMI,
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 5,
  summaryQueueLength: 10,
  summaryMaxTokens: 400,
})
export class ConversationCompaction {}
