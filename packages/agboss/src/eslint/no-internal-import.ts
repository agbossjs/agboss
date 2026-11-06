// Lint rule `agboss/no-internal-import` (#818): `@agboss/core/internal` is what the `agboss` CLI is
// built on — no semver promise, it changes in any release — so a project imports only the public
// entries. Flags every way a module names it: `import` / `export … from`, `import type`, a dynamic
// `import()`, `import x = require()`, `require()` and a type's `import("…")`, of the entry itself or
// a path under it. On for every file of a project (the config `agboss create` writes, the examples).
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

/** The entry only the CLI imports. */
export const INTERNAL_ENTRY = "@agboss/core/internal";

const ADVICE =
  "it is the agboss CLI's, with no semver promise — import from the public entries instead (`@agboss/core`, `@agboss/core/testing`, …; `studioOf` is in `@agboss/core/testing`)";

/** The message of the rule. */
export type InternalImportMessageId = "internal";

const isInternal = (specifier: unknown): specifier is string =>
  typeof specifier === "string" &&
  (specifier === INTERNAL_ENTRY || specifier.startsWith(`${INTERNAL_ENTRY}/`));

/** The module a literal names, when it is a string. */
const literalOf = (node: TSESTree.Node | null | undefined): unknown =>
  node?.type === AST_NODE_TYPES.Literal ? node.value : undefined;

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
        const { argument } = node;
        const literal =
          argument.type === AST_NODE_TYPES.TSLiteralType ? literalOf(argument.literal) : undefined;
        check(argument, literal);
      },
      CallExpression: (node) => {
        const { callee } = node;
        if (callee.type !== AST_NODE_TYPES.Identifier || callee.name !== "require") return;
        check(node, literalOf(node.arguments[0]));
      },
    };
  },
};
