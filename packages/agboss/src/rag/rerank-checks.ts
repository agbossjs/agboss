import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import { isDecisionModel } from "../models/decision-models.js";
import { DEFAULT_RERANKER_MODEL, type RagRerank } from "./types.js";

/**
 * The assembly rules of a knowledge base's reranking (#703), loaded only when one reranks: `by` is a
 * `@Reranker` (`[rag.not-a-reranker]`), `1 ≤ topK ≤ candidates` whole numbers
 * (`[rag.rerank-invalid]`), the reranker's name ends with `-reranker` (`[name.kind-suffix]`), a code
 * one has `rerank()` (`[reranker.missing-handler]`), a model one is on a chat model
 * (`[reranker.decision-model]`).
 */

const SUFFIX = "-reranker";

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

function countViolations(rag: string, rerank: RagRerank): RuleViolation[] {
  const { candidates, topK } = rerank;
  if (isCount(candidates) && isCount(topK) && topK <= candidates) return [];
  const message = `${rag}: rerank needs whole numbers 1 ≤ topK ≤ candidates (topK ${String(topK)}, candidates ${String(candidates)})`;
  return [violation("rag.rerank-invalid", message, [rag])];
}

function rerankerViolations(rag: string, by: Class): RuleViolation[] {
  const found = componentOf(by);
  if (found?.kind !== "reranker")
    return [
      violation("rag.not-a-reranker", `${rag}: rerank.by ${by.name} is not a @Reranker`, [rag]),
    ];
  const { meta } = found;
  const where = [meta.name];
  const problems: RuleViolation[] = [];
  if (!meta.name.endsWith(SUFFIX))
    problems.push(
      violation("name.kind-suffix", `${meta.name}: a reranker's name ends with ${SUFFIX}`, where),
    );
  if (meta.decidedBy === DecidedBy.Code) {
    const rerank: unknown = Reflect.get(by.prototype as object, "rerank");
    if (typeof rerank !== "function")
      problems.push(
        violation(
          "reranker.missing-handler",
          `${meta.name}: a code reranker implements rerank()`,
          where,
        ),
      );
  } else if (isDecisionModel(meta.model ?? DEFAULT_RERANKER_MODEL)) {
    const message = `${meta.name}: a reranker ranks on a chat model, ${String(meta.model)} is a decision model`;
    problems.push(violation("reranker.decision-model", message, where));
  }
  return problems;
}

/** Every reranking violation of the knowledge bases, at once; none → nothing thrown. */
export function checkRerankings(rags: readonly Class[]): void {
  const found = rags.flatMap((cls) => {
    const meta = componentOf(cls);
    if (meta?.kind !== "rag" || meta.meta.rerank === undefined) return [];
    const { name, rerank } = meta.meta;
    return [...countViolations(name, rerank), ...rerankerViolations(name, rerank.by)];
  });
  if (found.length > 0) throw new GraphRuleError({ violations: found });
}
