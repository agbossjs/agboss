import { describe, expect, it } from "vitest";
import { applicationOf } from "@agboss/core/internal";
import { checkApplicationModels } from "../../src/cli/check-models.js";
import { COMMANDS } from "../../src/cli/usage.js";
import { PricedApplication } from "../../../agboss/tests/models/fixtures/priced.workflow.js";
import { KIMI_ENTRY, providerStub } from "../../../agboss/tests/models/stub.js";
import { NotesApplication } from "../../../agboss/tests/models/fixtures/two-workflows.workflow.js";

describe("AC6: agboss check --models", () => {
  it("AC6: settings that fit print each model's provider and ok, exit code 0 — no API key needed", async () => {
    const report = await checkApplicationModels(
      await applicationOf(PricedApplication),
      {},
      providerStub([], [KIMI_ENTRY, { id: "local/llama" }]).fetch,
    );

    expect(report.exitCode).toBe(0);
    expect(report.lines.at(-1)).toBe("ok: 3 model settings fit their models");
    expect(report.lines[0]).toContain("agents.summariser-agent  local/llama · provider local");
  });

  it("AC6: every problem at once, with key, value, model and what it supports — exit code 1", async () => {
    const report = await checkApplicationModels(
      await applicationOf(PricedApplication),
      {},
      providerStub([], []).fetch,
    );

    expect(report).toEqual({
      exitCode: 1,
      lines: [
        "ConfigurationError: 2 model setting(s) do not fit their models",
        "  model.unknown-model  agents.summariser-agent = local/llama — model local/llama: local-model-provider does not list it",
        "  model.unknown-model  agents.writer-agent = moonshotai/kimi-k2.6 — model moonshotai/kimi-k2.6: openrouter-model-provider does not list it",
      ],
    });
  });

  it("#266 AC8: the check covers every model of every workflow of the application", async () => {
    const report = await checkApplicationModels(
      await applicationOf(NotesApplication),
      {},
      providerStub([], [{ id: "local/llama" }]).fetch,
    );

    expect(report).toEqual({
      exitCode: 1,
      lines: [
        "ConfigurationError: 1 model setting(s) do not fit their models",
        "  model.unknown-model  polishing-workflow agents.polishing-agent = moonshotai/kimi-k2.6 — model moonshotai/kimi-k2.6: openrouter-model-provider does not list it",
      ],
    });
  });

  it("#266 AC8: each model is checked against its resolved provider, every workflow named", async () => {
    const report = await checkApplicationModels(
      await applicationOf(NotesApplication),
      {},
      providerStub([], [KIMI_ENTRY, { id: "local/llama" }]).fetch,
    );

    expect(report.exitCode).toBe(0);
    expect(report.lines.map((line) => line.split(" · ").slice(0, 2).join(" · "))).toEqual([
      "drafting-workflow agents.drafting-agent  local/llama · provider local-model-provider",
      "drafting-workflow defaults.router  typesafe/jev-1.13 · provider decisions-model-provider",
      "polishing-workflow agents.polishing-agent  moonshotai/kimi-k2.6 · provider openrouter-model-provider",
      "polishing-workflow defaults.router  typesafe/jev-1.13 · provider decisions-model-provider",
      "ok: 4 model settings fit their models",
    ]);
  });

  it("AC6: agboss help lists the check command", () => {
    expect(COMMANDS.check?.usage).toBe(
      "agboss check [--models] [--cassettes] [--federation <snapshot…>] [--strict] [--profile <name>] [--env <name>] [--application <path>] [--json]",
    );
  });
});
