// The AGBoss lint rules, `agboss/…`, for this repository: the public entry `@agboss/core/eslint` (#388 S2,
// packages/agboss/src/eslint), the same one a project made by `agboss create` loads — so the
// framework is built before it is linted (`make check` builds first).
import { agbossPlugin } from "@agboss/core/eslint";

/** `agboss/no-component-state` (#261): framework sources and examples. */
export const componentStateRules = {
  files: ["packages/agboss/src/**/*.ts", "examples/*/src/**/*.ts"],
  plugins: { agboss: agbossPlugin },
  rules: { "agboss/no-component-state": "error" },
};

/** `agboss/no-direct-time` (#262): framework sources, the real Clock implementation excepted. */
export const directTimeRules = {
  files: ["packages/agboss/src/**/*.ts"],
  ignores: ["packages/agboss/src/infrastructure/clock.ts"],
  plugins: { agboss: agbossPlugin },
  rules: { "agboss/no-direct-time": "error" },
};

/** `agboss/no-internal-import` (#818): an example, like any project, never imports `@agboss/core/internal`. */
export const internalImportRules = {
  files: ["examples/**/*.{ts,mts,cts,js,mjs,cjs}"],
  plugins: { agboss: agbossPlugin },
  rules: { "agboss/no-internal-import": "error" },
};

/**
 * `repo/no-date-identity-compare` (#1307, G3): `===`, `!==`, `==` and `!=` on a `Date` compare the objects, so two
 * `Date`s of one instant differ — a compare-and-set, a ceiling or a "still the deadline I read" check written that way
 * loses every time. Compare `a.getTime() === b.getTime()` (the core's `sameInstant` / `isBefore`). A comparison with
 * `null`, `undefined` or a literal is fine. The rule needs type information (`projectService`).
 */
const isDateType = (checker, type) =>
  (type.isUnion() ? type.types : [type]).some((part) => part.getSymbol()?.getName() === "Date");

/** `null`, `undefined` and any literal (`date === "swallowed"` of a union is no instant compare). */
const isNullish = (node) =>
  node.type === "Literal" || (node.type === "Identifier" && node.name === "undefined");

export const noDateIdentityCompare = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      dates:
        "`{{operator}}` on a `Date` compares the objects, not the instants: compare `getTime()` (or use `sameInstant` / `isBefore`).",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (services?.program === undefined) return {};
    const checker = services.program.getTypeChecker();
    const isDate = (node) =>
      isDateType(checker, checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)));
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        if (isNullish(node.left) || isNullish(node.right)) return;
        if (isDate(node.left) || isDate(node.right))
          context.report({ node, messageId: "dates", data: { operator: node.operator } });
      },
    };
  },
};

export const repoPlugin = { rules: { "no-date-identity-compare": noDateIdentityCompare } };

export const dateIdentityRules = {
  files: ["packages/agboss/src/**/*.ts", "packages/agboss/tests/**/*.ts"],
  plugins: { repo: repoPlugin },
  rules: { "repo/no-date-identity-compare": "error" },
};

/** Every block of the AGBoss rules, in the order the repository's config lists them. */
/**
 * The error families (#1325): a type, a namespace of the variants' types and a constructor share one
 * name, which only a declared (type-only) namespace can do.
 */
const errorFamilyRules = {
  files: ["packages/agboss/src/core/error-families/*.ts", "packages/agboss/src/core/result.ts"],
  rules: { "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }] },
};

/** `AGBossTypes` (#1324g): the tables `.agboss/types.d.ts` fills, one declared (type-only) namespace. */
const generatedTypesRules = {
  files: ["packages/agboss/src/flow/generated-types.ts"],
  rules: { "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }] },
};

export const agbossRules = [
  componentStateRules,
  directTimeRules,
  internalImportRules,
  errorFamilyRules,
  generatedTypesRules,
  dateIdentityRules,
];
