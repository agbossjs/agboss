import { Float, List, Nested, Text, Url } from "../dto/decorators.js";
import { markOpen } from "../dto/metadata.js";
import type { JsonPrimitive } from "../infrastructure/fenced-effect.repository.js";

/** What a retrieval keeps about a passage beyond its text: plain JSON values by key. */
export class RagMetadataDto {
  readonly [name: string]: JsonPrimitive;
}
markOpen(RagMetadataDto);

/** A piece of text a knowledge base (`@Rag`) found for a query. */
export class RagSearchResultDto {
  @Text({ prompt: "the found text" })
  text!: string;

  @Text({ prompt: "where it comes from: a document, a page, a file" })
  source!: string;

  @Float({ prompt: "how well it matches the query: higher is better", optional: true })
  score?: number;

  @Text({
    prompt: "the passage's id in its knowledge base, when it has one",
    optional: true,
  })
  id?: string;

  @Text({ prompt: "the title of the document the passage is from", optional: true })
  title?: string;

  @Url({ prompt: "a link to the document", optional: true })
  url?: string;

  @Nested(RagMetadataDto, { prompt: "what else the knowledge base knows about it", optional: true })
  metadata?: Readonly<Record<string, JsonPrimitive>>;
}

/** A copy of a result with `patch` over it: what a reranker hands on (never a class instance's spread). */
export function copyOfResult(
  result: RagSearchResultDto,
  patch: { readonly score?: number; readonly source?: string; readonly text?: string } = {},
): RagSearchResultDto {
  const { id, title, url, metadata } = result;
  const optional = { score: patch.score ?? result.score, id, title, url, metadata };
  return {
    source: patch.source ?? result.source,
    text: patch.text ?? result.text,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}

/** The input of a search tool over a `@Rag`: `input: RagQueryDto` (`deps: [MyRag]`). */
export class RagQueryDto {
  @Text({ prompt: "what to search for", minLength: 1 })
  query!: string;
}

/** What a search over a `@Rag` found: the output of a search tool, `output: RagSearchResultsDto`. */
export class RagSearchResultsDto {
  @List(RagSearchResultDto, { prompt: "the most relevant passages, best first" })
  results!: readonly RagSearchResultDto[];
}

/** Where a statement in a reply comes from, in a knowledge base. */
export class RagSourceReferenceDto {
  @Text({ prompt: "what the source is: a document title, a page name" })
  title!: string;

  @Url({ prompt: "a link to the source", optional: true })
  url?: string;

  @Text({ prompt: "the exact words the reply relies on", optional: true, maxLength: 300 })
  quote?: string;
}
