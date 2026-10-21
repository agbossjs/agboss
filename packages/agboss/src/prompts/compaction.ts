/**
 * The texts of compaction (#120 PR 3): the built-in prompt of each strategy that writes summaries
 * (a `@Compaction` without `prompt` / `promptUrls` gets its strategy's), the headings of what the
 * compaction model reads, and the one "shorter" retry of a summary cut at `summaryMaxTokens`. Part of
 * the prompt version of a workflow that compacts.
 */

/** `CompactionStrategy.SummaryQueue`: each compaction writes a new self-contained note. */
export const SUMMARY_QUEUE_PROMPT = [
  "You compact part of a conversation between a user and an assistant into one memory note.",
  "Summarise ONLY the turns under `Turns to compact`. `Earlier turns` are context for resolving",
  "references — do not summarise them.",
  "The note must be self-contained: name people, companies, products and files in full; never use",
  "pronouns or words like 'it', 'he', 'that one' that point outside the note.",
  "Keep: facts about whoever started the run, decisions made, answers given, preferences, open questions and",
  "anything they may refer to later. Drop greetings and repetition. Plain text, at most 12 short lines.",
].join("\n");

/** `CompactionStrategy.SingleSummary`: the one summary, rewritten with the new turns. */
export const SINGLE_SUMMARY_PROMPT = [
  "You keep one running memory note of a conversation between a user and an assistant.",
  "Rewrite the note under `Current summary` so it also covers the turns under `Turns to add`; drop",
  "what is no longer true. With no current summary, write the first one from the turns.",
  "The note must be self-contained: name people, companies, products and files in full.",
  "Keep: facts about whoever started the run, decisions made, answers given, preferences and open",
  "questions. Plain text, at most 20 short lines.",
].join("\n");

/** The headings of what a queue's compaction reads. */
export const EARLIER_TURNS_HEADING = "Earlier turns (context only):";
export const TURNS_TO_COMPACT_HEADING = "Turns to compact:";

/** The headings of what a single summary's compaction reads. */
export const CURRENT_SUMMARY_HEADING = "Current summary:";
export const TURNS_TO_ADD_HEADING = "Turns to add:";

/** Asked once when a summary was cut at `summaryMaxTokens`. */
export const SHORTER_SUMMARY_REQUEST =
  "Your summary was cut off at its length limit. Write it again, shorter, so it ends within the limit.";

export const compactionPromptTexts: readonly string[] = [
  EARLIER_TURNS_HEADING,
  TURNS_TO_COMPACT_HEADING,
  CURRENT_SUMMARY_HEADING,
  TURNS_TO_ADD_HEADING,
  SHORTER_SUMMARY_REQUEST,
];
