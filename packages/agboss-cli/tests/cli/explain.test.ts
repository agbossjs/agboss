import { describe, expect, it } from "vitest";
import { agboss, envelope } from "./agboss.js";

/** #1325c: `agboss explain <code>` — what a rule or an error code means, and how to fix it. */

describe("agboss explain", () => {
  it("an assembly rule: what it means and before → after, from the skills' catalog", async () => {
    const call = await agboss(["explain", "graph.dead-end"]);

    expect(call.code).toBe(0);
    expect(call.stderr).toBe("");
    expect(call.stdout.split("\n")).toEqual([
      "graph.dead-end — an assembly rule: `agboss check`, `createApp` and `testWith` report it before any model call",
      "",
      "a path, case, group or side path stops before a finish",
      "",
      "Before → after:",
      "  `.toAgent(X)` as the last call → `.toAgent(X)` `.toFinish(F)`",
      "",
    ]);
  });

  it("takes the code as `check` prints it, in brackets", async () => {
    const call = await agboss(["explain", "[input.outdated-on-path]"]);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain("input.outdated-on-path — an assembly rule");
  });

  it("an error code: the class that throws it and how to catch it", async () => {
    const call = await agboss(["explain", "limit.budget"]);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      "limit.budget — an error: the framework throws it while a workflow runs",
    );
    expect(call.stdout).toContain(
      "Thrown as `LimitError.Budget`: catch it with `error instanceof LimitError.Budget`, `.onError(LimitError.Budget, …)` or `switch (error.code)`.",
    );
  });

  it("lists the code of every variant of every family, and every one is explained", async () => {
    const list = envelope(await agboss(["explain", "--list", "--json"])).result as {
      readonly codes: readonly string[];
    };

    expect(list.codes.length).toBeGreaterThan(300);
    expect(list.codes).toEqual(
      expect.arrayContaining([
        "graph.dead-end",
        "limit.budget",
        "step.agent",
        "pause.closed",
        "validation.dto-invalid",
      ]),
    );
    const explained = await Promise.all(
      list.codes.map((code) => agboss(["explain", code, "--json"])),
    );
    expect(explained.filter((call) => call.code !== 0)).toEqual([]);
  });

  it("--json: the explanation as data", async () => {
    const parsed = envelope(await agboss(["explain", "limit.budget", "--json"]));

    expect(parsed).toMatchObject({
      schema: 1,
      ok: true,
      command: "explain",
      result: { code: "limit.budget", kind: "error", thrownAs: "LimitError.Budget" },
    });
  });

  it("an unknown code: a usage error that names the nearest code", async () => {
    const call = await agboss(["explain", "graph.dead-ned"]);

    expect(call.code).toBe(2);
    expect(call.stderr).toContain(
      'no explanation for "graph.dead-ned". Did you mean "graph.dead-end"?',
    );
  });

  it("no code: a usage error", async () => {
    const call = await agboss(["explain"]);

    expect(call.code).toBe(2);
    expect(call.stderr).toContain("expected agboss explain <code>");
  });
});
