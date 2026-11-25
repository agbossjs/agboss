import { describe, expect, it } from "vitest";
import { TestModelProvider } from "../../src/testing/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import type { ModelProviderRequest } from "../../src/models/index.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";
import { testWith } from "../../src/testing/index.js";

/** #1328 (Q8): /testing makes no provider of its own; a test application names `TestModelProvider`. */

const named = testWith(HistoryDeskApplication, { modelProvider: TestModelProvider });

describe("TestModelProvider", () => {
  it("is a transport provider that chats and decides, and is never reached by a scripted test", async () => {
    const provider = new TestModelProvider();

    await expect(provider.complete({ model: "m" } as ModelProviderRequest)).rejects.toThrow(
      "a test called m with no script for it",
    );
    await expect(provider.decide({ model: "d", state: "s", questions: {} })).rejects.toThrow(
      "a test decided on d with no script for it",
    );
    expect(modelProviderOf(TestModelProvider).name).toBe("test-model-provider");
  });

  named("serves an application that names it", async ({ app }) => {
    await app.ready();

    expect(app.get(TestModelProvider)).toBeInstanceOf(TestModelProvider);
  });
});
