// Lint rules for test files (split from eslint.config.js to keep it under the line limit).
const FAKE_INTERRUPT = [
  "AssignmentExpression[left.object.type!='ThisExpression'][left.property.name='name'][right.value=/Interrupt$/]",
  "Property[key.name='name'][value.value=/Interrupt$/]",
].map((selector) => ({
  selector,
  message: "Do not fake a LangGraph interrupt — pause the run for real (testWith).",
}));

// #630: a synchronous child process holds the vitest fork's event loop; held 60 s, its pending
// `onTaskUpdate` times out, the fork's run rejects and vitest 3's forks pool skips the singleFork
// fault suite whole. Only packages/agboss runs two projects on one pool.
const BLOCKING = "/^(spawnSync|execFileSync|execSync)$/";
const BLOCKING_CHILD_PROCESS = [
  `ImportDeclaration[source.value=/^(node:)?child_process$/] ImportSpecifier[imported.name=${BLOCKING}]`,
  `MemberExpression[property.name=${BLOCKING}]`,
].map((selector) => ({
  selector,
  message:
    "No synchronous child process in a test (#630): it can drop the fault suite from the run — await one with tests/helpers/process.ts.",
}));

const allTests = {
  files: [
    "packages/agboss/tests/**/*.ts",
    "packages/agboss-cli/tests/**/*.ts",
    "examples/*/tests/**/*.ts",
  ],
  rules: {
    "max-lines": "off",
    "max-lines-per-function": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-unsafe-call": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unused-vars": "off",
    // a test must not imitate the framework's failures: the real path has to produce them (#180)
    "no-restricted-syntax": ["error", ...FAKE_INTERRUPT],
  },
};

export const testRules = [
  allTests,
  {
    files: ["packages/agboss/tests/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...FAKE_INTERRUPT, ...BLOCKING_CHILD_PROCESS] },
  },
];
