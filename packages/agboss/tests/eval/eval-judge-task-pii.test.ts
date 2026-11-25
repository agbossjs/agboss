/**
 * #1301: the task line an eval's judge reads is the stored one — the start DTO's `tokenize()` field
 * as its token, its `mask()` field as its mask — so the judge's model never sees a raw value.
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

const AUTHOR = "zoe-7-secret";
const REPORTER = "reporter-4-secret";

@EvalSuite({
  name: "task-pii-eval-suite",
  description: "A judged start with sensitive fields",
  start: JudgedDeskStart,
  judges: [TaskPiiJudge],
  cases: [
    evalCase({
      name: "sensitive-start",
      tenant: { tenantId: "eval-acme" },
      input: { text: "Hello", author: AUTHOR, reporter: REPORTER },
    }),
  ],
})
class TaskPiiEvalSuite {}

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

describe("#1301: the eval judge's task line", () => {
  it("holds the start DTO's token and mask, never a raw value", async () => {
    const env = await TestEnvironment.of(JudgedDeskApplication);
    environment = env;
    env.mockModel(JudgedDeskAgent).thenReturn(replyWith("Hi."));
    const key = judgeKeyOf("task-pii-judge");
    env.book.name(key, TaskPiiJudge.name);
    const script = env.book.scriptOf(key);
    script.thenReturn(replyWith('{"passed":true,"reason":""}'));

    const report = await runSuiteOn(await env.newApp(), TaskPiiEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.checks.map((check) => check.status)).toContain(CheckStatus.Passed);
    expect(script.requests).toHaveLength(1);
    const sent = JSON.stringify(script.requests);
    expect(sent).toContain("Hello");
    expect(sent).not.toContain(AUTHOR);
    expect(sent).not.toContain(REPORTER);
    const request = script.requests[0] as { input: string };
    // the task is a JSON string in the request: `<` is written <
    expect(request.input).toMatch(/\\u003cauthor>/u);
    expect(request.input).toMatch(/\\u003creporter:[0-9a-f]{6,}>/u);
  });
});
