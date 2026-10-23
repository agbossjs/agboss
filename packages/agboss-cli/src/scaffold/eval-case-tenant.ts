import ts from "typescript";
import { casesOf, propertyOf } from "./eval-case-source.js";
import type { FileToWrite } from "./write.js";

/**
 * The tenant a case of a suite's file is written for (#397 PR 5b): the string `tenantId` of its
 * `evalCase({ name, tenant: { tenantId: "…" } })` — undefined when the file does not say (no such
 * case, no `tenant`, a value that is not a literal), so the caller does not narrow by it.
 */
export function caseTenantIdOf(
  file: FileToWrite,
  suite: string,
  caseName: string,
): string | undefined {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const options = (casesOf(source, suite)?.elements ?? [])
    .flatMap((element) => (ts.isCallExpression(element) ? element.arguments.slice(0, 1) : []))
    .filter(ts.isObjectLiteralExpression)
    .find((found) => {
      const name = propertyOf(found, "name");
      return name !== undefined && ts.isStringLiteralLike(name) && name.text === caseName;
    });
  const tenant = options === undefined ? undefined : propertyOf(options, "tenant");
  if (tenant === undefined || !ts.isObjectLiteralExpression(tenant)) return undefined;
  const tenantId = propertyOf(tenant, "tenantId");
  return tenantId !== undefined && ts.isStringLiteralLike(tenantId) ? tenantId.text : undefined;
}
