import { describe, expect, it } from "vitest";
import { routeTo, fakeDeps, runText } from "./helpers.js";

describe("interrupted runs", () => {
  it("an aborted signal stops the run and stores an interrupted Turn", async () => {
    const deps = await fakeDeps({
      "test/router": [routeTo("alpha-agent")],
      "test/alpha": ["ok"],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(runText("Hi", deps, { signal: controller.signal })).rejects.toThrow(
      "the run was cancelled",
    );

    expect((await deps.terns.summary("test-bundle-workflow"))[0]).toMatchObject({ terns: 1 });
  });
});
