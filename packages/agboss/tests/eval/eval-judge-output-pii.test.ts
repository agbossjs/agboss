/**
 * The eval judge reads the stored output (#1301, #1328): a value the application's PII policy hides
 * from models reaches the judge's model as its token, never raw.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EvalSuite, evalCase, CheckStatus } from "../../src/eval/index.js";
import { runSuiteOn } from "../../src/eval/run/run-suite.js";
import { replyWith } from "../../src/testing/index.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { judgeKeyOf } from "../../src/testing/scripted-gateway.js";
import {
  JudgedDeskAgent,
  JudgedDeskApplication,
  JudgedDeskStart,
  TaskPiiJudge,
} from "../flow/fixtures/eval-pii.fixture.js";

const OUT_EMAIL = "bob.out@example.com";

@EvalSuite({
  name: "output-pii-eval-suite",
  description: "A judged answer with an email in it",
  start: JudgedDeskStart,
  judges: [TaskPiiJudge],
  cases: [
    evalCase({
      name: "email-in-answer",
      tenant: { tenantId: "eval-acme" },
      input: { text: "Hello, I am alice.in@example.com" },
    }),
  ],
})
class OutputPiiEvalSuite {}

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

describe("the eval judge's output", () => {
  it("holds the token of an email, never the email", async () => {
    const env = await TestEnvironment.of(JudgedDeskApplication);
    environment = env;
    env.mockLlm(JudgedDeskAgent).thenReturn(replyWith(`Write to ${OUT_EMAIL}.`));
    const key = judgeKeyOf("task-pii-judge");
    env.book.name(key, TaskPiiJudge.name);
    const script = env.book.scriptOf(key);
    script.thenReturn(replyWith('{"passed":true,"reason":""}'));

    const report = await runSuiteOn(await env.newApp(), OutputPiiEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.checks.map((check) => check.status)).toContain(CheckStatus.Passed);
    const sent = JSON.stringify(script.requests);
    expect(sent).not.toContain("alice.in");
    expect(sent).not.toContain("bob.out");
    expect(sent).toMatch(/u003cemail:[0-9a-f]{6}>/u);
  });
});
