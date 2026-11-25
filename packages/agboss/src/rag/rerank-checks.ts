import { ConfigError } from "../core/error-families/config-errors.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { kebabNameProblem } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The assembly rules of a knowledge base's reranking, loaded only when one reranks: `reranker` is a
 * `@RagReranker` (`[rag.not-a-reranker]`), `candidates` and `topK` are whole numbers with
 * `1 ≤ topK ≤ candidates` (`[rag.rerank-invalid]`), the reranker's name is kebab-case.
 */

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

function countViolations(rag: string, topK: number, candidates: unknown): RuleViolation[] {
  if (isCount(candidates) && isCount(topK) && topK <= candidates) return [];
  const message = `${rag}: a reranked @Rag needs whole numbers 1 ≤ topK ≤ reranker.candidates (topK ${String(topK)}, candidates ${String(candidates)})`;
  return [violation("rag.rerank-invalid", message, [rag])];
}

function rerankerViolations(rag: string, topK: number, reranker: Class): RuleViolation[] {
  const found = componentOf(reranker);
  if (found?.kind !== "reranker")
    return [
      violation("rag.not-a-reranker", `${rag}: reranker ${reranker.name} is not a @RagReranker`, [
        rag,
      ]),
    ];
  const { meta } = found;
  const where = [meta.name];
  const problems = countViolations(rag, topK, meta.candidates);
  const nameProblem = kebabNameProblem(meta.name, "a reranker");
  if (nameProblem !== undefined)
    problems.push(violation(nameProblem.code, nameProblem.message, where));
  const { maxCandidateLength } = meta;
  if (maxCandidateLength !== undefined && !isCount(maxCandidateLength))
    problems.push(
      violation(
        "rag.rerank-invalid",
        `${meta.name}: maxCandidateLength is a whole number of characters ≥ 1 (got ${String(maxCandidateLength)})`,
        where,
      ),
    );
  return problems;
}

/** Every reranking violation of the knowledge bases, at once; none → nothing thrown. */
export function checkRerankings(rags: readonly Class[]): void {
  const found = rags.flatMap((cls) => {
    const meta = componentOf(cls);
    if (meta?.kind !== "rag" || meta.meta.reranker === undefined) return [];
    const { name, topK, reranker } = meta.meta;
    return rerankerViolations(name, topK, reranker);
  });
  if (found.length > 0) throw new ConfigError.GraphRules({ violations: found });
}
