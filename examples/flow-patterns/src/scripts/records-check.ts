import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

// npm run records:check — the desk's history offline (#401, #396 PR 8, #397 PR 5), no key:
// one run of the desk kept in `.agboss/desk-offline.sqlite`, the kept records exported as JSON
// Lines, and an eval case drafted from the newest one (--dry-run: printed, the suite untouched) —
// what `agboss eval ui`'s "Save as golden case" writes into the suite.
const application = ["--application", "src/desk.application.ts", "--env", "offline"];
const env = { ...process.env, PII_PSEUDONYM_KEY: process.env.PII_PSEUDONYM_KEY ?? "offline-only" };
const agboss = (...args: readonly string[]): string =>
  execFileSync("npx", ["agboss", ...args, ...application], { env, encoding: "utf8" });

agboss(
  "run",
  "--start",
  "desk-workflow-start",
  "--input",
  JSON.stringify({ customerId: "c-1", question: "Where is order #7?" }),
);
mkdirSync(".agboss/records", { recursive: true });
const out = ".agboss/records/desk.jsonl";
agboss("records", "export", "--tenant", "default", "--out", out);

const lines = readFileSync(out, "utf8").trim().split("\n");
const newest: unknown = JSON.parse(lines.at(-1) ?? "{}");
const executionId =
  typeof newest === "object" && newest !== null && "executionId" in newest
    ? String(newest.executionId)
    : "";
if (executionId === "") throw new Error(`${out} holds no execution record`);
process.stdout.write(`records: ${String(lines.length)} kept, the newest ${executionId}\n`);
process.stdout.write(
  agboss(
    "generate",
    "eval-case",
    "lookup-from-history",
    "--suite",
    "desk-eval-suite",
    "--from-execution",
    executionId,
    "--dry-run",
  ),
);
