// Lint rule `agboss/no-internal-import` (#818): `@agboss/core/internal` is what the `agboss` CLI is
// built on — no semver promise, it changes in any release — so a project imports only the public
// entries. Flags every way a module names it — `import` / `export … from`, `import type`, a dynamic
// `import()`, `import x = require()`, `require()` / `require.resolve()`, `import.meta.resolve()`,
// vitest's `vi.mock()` / `vi.importActual()` and the like, a type's `import("…")` and a
// triple-slash `reference types` directive — by a string or a template without placeholders, of the entry
// itself or a path under it. On for every file of a project (the config `agboss create` writes, the
// examples).
import {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

/** The entry only the CLI imports. */
export const INTERNAL_ENTRY = "@agboss/core/internal";

const ADVICE =
  "it is the agboss CLI's, with no semver promise — import from the public entries instead (`@agboss/core`, `@agboss/core/testing`, …; `studioOf` is in `@agboss/core/testing`)";

/** The message of the rule. */
export type InternalImportMessageId = "internal";

const isInternal = (specifier: unknown): specifier is string =>
  typeof specifier === "string" &&
  (specifier === INTERNAL_ENTRY || specifier.startsWith(`${INTERNAL_ENTRY}/`));

/** The module a literal names: a string, or a template without placeholders. */
function literalOf(node: TSESTree.Node | null | undefined): unknown {
  if (node?.type === AST_NODE_TYPES.Literal) return node.value;
  if (node?.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  return undefined;
}

/** Calls whose first argument names a module: `require.resolve`, `vi.mock`, `vi.importActual`, … */
const MODULE_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["require", new Set(["resolve"])],
  ["vi", new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])],
  ["vitest", new Set(["mock", "doMock", "importActual", "importMock"])],
]);

/** Whether a call's callee takes a module as its first argument. */
function namesModule(callee: TSESTree.Expression): boolean {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name === "require";
  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) return false;
  const { object, property } = callee;
  if (property.type !== AST_NODE_TYPES.Identifier) return false;
  // import.meta.resolve("…")
  if (object.type === AST_NODE_TYPES.MetaProperty) return property.name === "resolve";
  return (
    object.type === AST_NODE_TYPES.Identifier &&
    MODULE_METHODS.get(object.name)?.has(property.name) === true
  );
}

const REFERENCE_TYPES = /^\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/u;

export const noInternalImport: TSESLint.RuleModule<InternalImportMessageId> = {
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "No import of @agboss/core/internal: the public entries only" },
    messages: { internal: "`{{module}}` is not for projects: {{advice}}." },
    schema: [],
  },
  create(context) {
    const check = (node: TSESTree.Node, specifier: unknown): void => {
      if (isInternal(specifier))
        context.report({
          node,
          messageId: "internal",
          data: { module: specifier, advice: ADVICE },
        });
    };
    return {
      ImportDeclaration: (node) => {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration: (node) => {
        check(node, node.source?.value);
      },
      ExportAllDeclaration: (node) => {
        check(node.source, node.source.value);
      },
      ImportExpression: (node) => {
        check(node.source, literalOf(node.source));
      },
      TSExternalModuleReference: (node) => {
        check(node.expression, literalOf(node.expression));
      },
      TSImportType: (node) => {
        check(node.source, node.source.value);
      },
      CallExpression: (node) => {
        if (node.callee.type === AST_NODE_TYPES.Super || !namesModule(node.callee)) return;
        check(node, literalOf(node.arguments[0]));
      },
      Program: () => {
        for (const comment of context.sourceCode.getAllComments()) {
          const named = REFERENCE_TYPES.exec(comment.value)?.[1];
          if (comment.type === AST_TOKEN_TYPES.Line && isInternal(named))
            context.report({
              loc: comment.loc,
              messageId: "internal",
              data: { module: named, advice: ADVICE },
            });
        }
      },
    };
  },
};
