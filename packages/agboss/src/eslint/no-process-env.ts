// Lint rule `agboss/no-process-env` (#1324): configuration is read through `defineEnv` (`env.text(…)`,
// `secret(…)`), checked at assembly and by `agboss check`, never from `process.env` in the middle of a
// component — a raw read is invisible to `agboss check`, to profiles and to the tests' `processEnv`.
// Flags `process.env` (and `process["env"]`, `const { env } = process`, `import { env } from
// "node:process"`) in a project's `src/`. Allowed: forwarding the whole object under the name of the
// option that takes it — `createApp(App, { processEnv: process.env })` in a bootstrap entry point —
// and every test file (`*.test.ts`, `*.spec.ts`, `tests/**`).
import { AST_NODE_TYPES, TSESLint, type TSESTree } from "@typescript-eslint/utils";

const ADVICE =
  'declare the variable with `defineEnv` (`env.text("NAME")`, `secret("NAME")`) so `agboss check` and the profiles see it; forward `process.env` only as `processEnv: process.env` in an entry point';

/** The message of the rule. */
export type ProcessEnvMessageId = "raw";

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|[\\/])tests[\\/])/u;
const PROCESS_MODULES: ReadonlySet<string> = new Set(["process", "node:process"]);

/** Whether `identifier` names the global `process` (a local of the same name is not flagged). */
function isGlobalProcess(
  identifier: TSESTree.Identifier,
  scopeManager: TSESLint.Scope.ScopeManager | null,
): boolean {
  if (identifier.name !== "process" || scopeManager === null) return false;
  const reference = scopeManager.scopes
    .flatMap((scope) => scope.references)
    .find((one) => one.identifier === identifier);
  const variable = reference?.resolved ?? null;
  return (
    variable === null ||
    (variable.scope.type === TSESLint.Scope.ScopeType.global && variable.defs.length === 0)
  );
}

const keyName = (property: TSESTree.Property): string | undefined =>
  property.key.type === AST_NODE_TYPES.Identifier && !property.computed
    ? property.key.name
    : undefined;

/** `{ processEnv: process.env }`: the whole object handed to the option that reads it. */
const isForwarded = (member: TSESTree.MemberExpression): boolean =>
  member.parent.type === AST_NODE_TYPES.Property &&
  member.parent.value === member &&
  keyName(member.parent) === "processEnv";

const isEnvName = (member: TSESTree.MemberExpression): boolean =>
  (!member.computed &&
    member.property.type === AST_NODE_TYPES.Identifier &&
    member.property.name === "env") ||
  (member.property.type === AST_NODE_TYPES.Literal && member.property.value === "env");

export const noProcessEnv: TSESLint.RuleModule<ProcessEnvMessageId> = {
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "No raw `process.env`: `defineEnv` only" },
    messages: { raw: "`process.env` is read directly: {{advice}}." },
    schema: [],
  },
  create(context) {
    if (TEST_FILE.test(context.filename)) return {};
    const report = (node: TSESTree.Node): void => {
      context.report({ node, messageId: "raw", data: { advice: ADVICE } });
    };
    return {
      MemberExpression: (node) => {
        if (node.object.type !== AST_NODE_TYPES.Identifier || !isEnvName(node)) return;
        if (!isGlobalProcess(node.object, context.sourceCode.scopeManager)) return;
        if (!isForwarded(node)) report(node);
      },
      // const { env } = process
      VariableDeclarator: (node) => {
        const { id, init } = node;
        if (id.type !== AST_NODE_TYPES.ObjectPattern || init?.type !== AST_NODE_TYPES.Identifier)
          return;
        if (!isGlobalProcess(init, context.sourceCode.scopeManager)) return;
        const takesEnv = id.properties.some(
          (property) => property.type === AST_NODE_TYPES.Property && keyName(property) === "env",
        );
        if (takesEnv) report(node);
      },
      // import { env } from "node:process"
      ImportDeclaration: (node) => {
        if (!PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          const named =
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.imported.type === AST_NODE_TYPES.Identifier &&
            specifier.imported.name === "env";
          if (named) report(specifier);
        }
      },
    };
  },
};
