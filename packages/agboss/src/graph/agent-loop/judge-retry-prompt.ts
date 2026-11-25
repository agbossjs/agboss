import type { JudgeRejection } from "../step-coordinates.js";

/** What the agent reads before its retry: every rejecting judge's reason. */
export const retryPrompt = (rejected: readonly JudgeRejection[]): string =>
  [
    "Your reply did not pass the quality gate. Fix the following and reply again:",
    ...rejected.map((r) => `- [${r.judge}] ${r.reason}`),
  ].join("\n");
