import { indexOf, retrieveOf } from "../../src/rag/rag-source.js";
import type {
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
} from "../../src/rag/types.js";

/** A source's protected `retrieve`, as the core calls it. */
export const retrieve = (
  source: object,
  query: string,
  options: RagRetrieveOptions<unknown>,
): Promise<RagRetrieval> => retrieveOf(source, query, options);

/** A source's protected `index`, as the core calls it; a source without one is a failure. */
export async function index(source: object, options: RagIndexOptions): Promise<RagIndexReport> {
  const report = await indexOf(source, options);
  if (report === undefined) throw new TypeError("the source has no index");
  return report;
}
