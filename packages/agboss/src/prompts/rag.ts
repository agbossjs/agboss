import type { RagSearchResultDto } from "../rag/dto.js";

/** Asked of the model with the knowledge block. Part of the prompt version. */
export const CITE_INSTRUCTION =
  "Answer from these search results when they are relevant and cite each fact's source as [source]. Say when they do not cover the question.";

/** Search results put before the task. */
export const knowledgeBlock = (name: string, results: readonly RagSearchResultDto[]): string =>
  `Knowledge (${name}):\n${results.map((r) => `[${r.source}] ${r.text}`).join("\n\n")}`;

export const ragPromptTexts: readonly string[] = [CITE_INSTRUCTION, knowledgeBlock("", [])];
