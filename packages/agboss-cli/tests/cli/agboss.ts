import { runCli } from "../../src/cli/run-cli.js";

/** One `agboss` call in-process: its exit code and everything it wrote. */
export interface AgbossCall {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The CLI's own fixtures (`cli/…`) or a workflow of the framework's tests (`test-workflow/…`). */
export const fixture = (name: string): string =>
  new URL(
    name.startsWith("cli/") ? `../fixtures/${name}` : `../../../agboss/tests/fixtures/${name}`,
    import.meta.url,
  ).pathname;

/** `agboss <argv…>` with no API key (unless `env` gives one) and no terminal; TypeScript is already compiled by vitest. */
export async function agboss(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = {},
): Promise<AgbossCall> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
    cwd,
    stdinIsTTY: false,
    registerTypeScript: false,
  });
  return { code, stdout, stderr };
}

/** The `--json` envelope on stdout (throws when stdout is not exactly one JSON value). */
export const envelope = (call: AgbossCall): Record<string, unknown> =>
  JSON.parse(call.stdout) as Record<string, unknown>;

/** The checks `agboss check` runs on every workflow (#261: the application's warnings too). */
export const CHECKS_RUN = "assembly, environment, application, prompts, types";

/** The assembly warning of an application without `pseudonymKey` (#120 S94), as printed. */
export const piiKeyWarning = (file: string): string =>
  `warning: ${file} application.pii-instance-key no @Application({ pseudonymKey }): sensitive fields and policies without their own key make PII tokens with a key of this instance — one value gets another token on each instance, so logs and traces compare across instances only with pseudonymKey\n`;

/** The assembly warning of an application on the built-in in-memory cost ledger (#261), as printed. */
export const ledgerWarning = (file: string): string =>
  `warning: ${file} application.in-memory-cost-ledger in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart\n`;

/** One start's worst case in `agboss check`'s report (#268 AC5): one workflow, no children. */
const singleWorstCase = (start: string, workflow: string, steps: number): string[] => [
  `Worst case of one ${start} call`,
  `  workflow executions     1  1 ${workflow}`,
  `  at the same time        1  1 ${workflow}`,
  `  agent and router steps  ${String(steps)}  ${String(steps)} in ${workflow} (longest path)`,
  `  nesting depth           1  ${workflow}`,
];

/** `agboss check`'s report of the framework's test-workflow fixture (`test-application`), as printed. */
export const TEST_APPLICATION_REPORT = `${[
  "test-application 1.0.0, environment dev",
  "",
  ...singleWorstCase("chat-workflow-start", "test-workflow", 2),
  "",
].join("\n")}\n`;

/** `agboss check`'s report of the CLI's parts fixture (`parts-application`), as printed. */
export const PARTS_APPLICATION_REPORT = `${[
  "parts-application 1.0.0, environment dev",
  "",
  ...singleWorstCase("five-parts-workflow-start", "parts-workflow", 1),
  "",
  ...singleWorstCase("six-parts-workflow-start", "parts-workflow", 1),
  "",
].join("\n")}\n`;
