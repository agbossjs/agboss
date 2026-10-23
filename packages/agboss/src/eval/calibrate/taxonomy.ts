import { parse } from "yaml";
import { z } from "zod";

/**
 * The failure taxonomy of a project (#397 PR 4): `eval/failure-taxonomy.yaml`, the closed list of
 * tags a person may give a failed run — so labels speak one language and their counts mean
 * something. Each tag kebab-case, unique, with what it means.
 */

/** One failure tag: its name and what it means. */
export interface EvalFailureTag {
  readonly tag: string;
  readonly description: string;
}

/** What reading a taxonomy gave: its tags, or why the file is not one. */
export type EvalFailureTaxonomyRead =
  | { readonly kind: "read"; readonly tags: readonly EvalFailureTag[] }
  | { readonly kind: "invalid"; readonly reason: string };

const TaxonomySchema = z.object({
  tags: z.array(
    z.object({
      tag: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "a kebab-case tag (missed-policy)"),
      description: z.string().min(1),
    }),
  ),
});

/** The first issue, with where it is. */
function issueText(issues: readonly z.core.$ZodIssue[]): string {
  const [issue] = issues;
  if (issue === undefined) return "not a taxonomy";
  const where = issue.path.join(".");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/** The taxonomy in `content` (YAML), or why it is not one. */
export function failureTaxonomyOf(content: string): EvalFailureTaxonomyRead {
  let value: unknown;
  try {
    value = parse(content);
  } catch (error) {
    return {
      kind: "invalid",
      reason: `not YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = TaxonomySchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid", reason: issueText(parsed.error.issues) };
  const seen = new Set<string>();
  for (const { tag } of parsed.data.tags) {
    if (seen.has(tag)) return { kind: "invalid", reason: `tag ${tag} twice` };
    seen.add(tag);
  }
  return { kind: "read", tags: parsed.data.tags };
}
