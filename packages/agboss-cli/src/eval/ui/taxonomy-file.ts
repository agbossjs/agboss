import { existsSync, readFileSync } from "node:fs";
import { failureTaxonomyOf, type EvalFailureTag } from "@agboss/core/internal";
import { CliError } from "../../cli/errors.js";

/**
 * The project's failure taxonomy for `agboss eval ui` (#397 PR 4): `eval/failure-taxonomy.yaml`
 * unless `--taxonomy` names another — its tags the only ones a label may carry. No file → no tags
 * offered (a label then has none); a file that is not a taxonomy stops the UI before it serves.
 */
export function taxonomyTagsOf(file: string, shown: string): readonly EvalFailureTag[] | undefined {
  if (!existsSync(file)) return undefined;
  const read = failureTaxonomyOf(readFileSync(file, "utf8"));
  if (read.kind === "read") return read.tags;
  throw new CliError(
    "usage",
    "eval.taxonomy-invalid",
    `${shown} is not a failure taxonomy: ${read.reason}`,
  );
}
