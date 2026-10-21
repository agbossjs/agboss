import { describe, expect, it } from "vitest";
import { startsOfApplication } from "agboss/internal";
import { closestName } from "../../src/cli/did-you-mean.js";
import { chooseStart } from "../../src/cli/start-choice.js";
import { DeskApplication } from "../fixtures/cli/desk/desk.workflow.js";
import { TestApplication } from "../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { agboss, envelope, fixture } from "./agboss.js";

/** #268 AC2: a command runs a workflow chosen by its start's full name. */

const ONE = startsOfApplication(TestApplication);
/** Two workflows of actions, four starts: a run needs no model (the key is a placeholder). */
const SEVERAL = startsOfApplication(DeskApplication);
const DESK = fixture("cli/desk/desk.workflow.ts");
const KEY = { OPENROUTER_API_KEY: "unused" };
const LIST = [
  "inbox-workflow-start (A message to the inbox; inbox-workflow)",
  "batch-screening-workflow-start (Companies to screen at once; screening-workflow)",
  "criteria-screening-workflow-start (A company to screen against the search's criteria; screening-workflow)",
  "screening-workflow-start (A company to screen; screening-workflow)",
].join(", ");

/** The commands that run one workflow, each with what it needs besides --start. */
const BY_START: readonly (readonly string[])[] = [
  ["chat"],
  ["run", "find jobs"],
  ["eval"],
  ["replay", "--version", "v1"],
  ["golden", "add", "--name", "smoke"],
  ["compare", "--profiles", "base,fast"],
];

describe("#268 AC2: choosing a start", () => {
  it("one start optional: with one start in the application --start may be omitted", () => {
    expect(chooseStart("run", ONE, undefined).name).toBe("chat-workflow-start");
    expect(chooseStart("run", ONE, "chat-workflow-start").name).toBe("chat-workflow-start");
  });

  it("list when several: none given → an error with each start's name, description and workflow", () => {
    expect(() => chooseStart("run", SEVERAL, undefined)).toThrow(
      `The application has 4 starts: choose one with --start <name> — ${LIST} — see agboss help run`,
    );
  });

  it("the full name chooses: exact, never by a part of it", () => {
    expect(chooseStart("eval", SEVERAL, "screening-workflow-start").name).toBe(
      "screening-workflow-start",
    );
    expect(chooseStart("eval", SEVERAL, "inbox-workflow-start").workflow).toBe("inbox-workflow");
  });

  it('did you mean, nothing runs: a name no start has → "Did you mean" + the list', () => {
    expect(() => chooseStart("run", SEVERAL, "batch-screening")).toThrow(
      `Start "batch-screening" not found. Did you mean "batch-screening-workflow-start"? The starts: ${LIST}`,
    );
    expect(() => chooseStart("run", SEVERAL, "payments")).toThrow(
      `Start "payments" not found. The starts: ${LIST}`,
    );
  });

  it("the hint is the nearest name: a missing suffix, a typo — nothing when far", () => {
    const names = ["screening-workflow-start", "inbox-workflow-start"];

    expect(closestName("screening", names)).toBe("screening-workflow-start");
    expect(closestName("inbox-workflow-strat", names)).toBe("inbox-workflow-start");
    expect(closestName("payments", names)).toBeUndefined();
  });

  it.each(BY_START)(
    "agboss %s: several starts, none given → exit 2 listing them; nothing starts",
    async (...argv) => {
      const call = await agboss([...argv, "--application", DESK, "--json"]);

      expect(call.code).toBe(2);
      expect(envelope(call)).toMatchObject({ ok: false, error: { code: "start.required" } });
      expect(call.stderr).toContain(LIST);
      expect(call.stderr).not.toContain("Started");
    },
  );

  it.each(BY_START)(
    "agboss %s: an unknown --start → exit 2 with the hint; nothing starts",
    async (...argv) => {
      const call = await agboss([...argv, "--application", DESK, "--start", "inbox"]);

      expect(call.code).toBe(2);
      expect(call.stdout).toBe("");
      expect(call.stderr).toContain(
        'Start "inbox" not found. Did you mean "inbox-workflow-start"?',
      );
    },
  );

  it("--start runs the workflow its start opens — each of the application's workflows", async () => {
    const screening = await agboss(
      [
        "run",
        "--application",
        DESK,
        "--start",
        "screening-workflow-start",
        "--input",
        '{"name":"Acme"}',
        "--json",
      ],
      process.cwd(),
      KEY,
    );
    const inbox = await agboss(
      ["run", "--application", DESK, "--start", "inbox-workflow-start", "hello", "--json"],
      process.cwd(),
      KEY,
    );

    expect(screening.code).toBe(0);
    expect(envelope(screening).result).toMatchObject({
      start: "screening-workflow-start",
      status: "finished",
      finish: "score-workflow-finish",
      output: { score: "Acme: fits" },
    });
    expect(envelope(inbox).result).toMatchObject({
      start: "inbox-workflow-start",
      finish: "echo-workflow-finish",
      output: { text: "echo: hello" },
    });
  });
});
