import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowDeps } from "../src/app/app-deps.js";
import { standaloneInfrastructure } from "../src/application/application-container.js";
import { TernStoreRecordRepository } from "../src/infrastructure/execution-record.repository.js";
import { providerStub } from "./models/stub.js";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { workflowOf } from "../src/testing/index.js";
import { createSqliteTernStore } from "../src/terns/index.js";
import { runVersions } from "../src/run/versions.js";
import { usd } from "../src/units/index.js";
import { routeTo, fakeDeps, runText } from "./helpers.js";

describe("config versions", () => {
  it("#116: the flow's routers, their texts and the limits are part of the versions", async () => {
    const deps = await fakeDeps({});
    const [main] = deps.routers;
    if (main === undefined) throw new Error("test router missing");
    const base = runVersions(deps);

    const reworded = runVersions({
      ...deps,
      routers: [
        {
          ...main,
          instructions: "Choose well.",
        },
      ],
    });
    const otherModel = runVersions({ ...deps, routers: [{ ...main, model: "typesafe/jev-2" }] });
    const limited = runVersions({ ...deps, maxSteps: 3 });
    const cheaper = runVersions({ ...deps, limits: { perRun: { cost: usd(0.5) } } });

    expect(reworded.promptVersion).not.toBe(base.promptVersion);
    expect(otherModel.modelVersion).not.toBe(base.modelVersion);
    expect(limited.configHash).not.toBe(base.configHash);
    expect(cheaper.configHash).not.toBe(base.configHash);
  });

  it("AC2: every run is labelled with the declared version and the config hash", async () => {
    const deps = await fakeDeps({
      "test/router": [routeTo("alpha-agent")],
      "test/alpha": ["ok"],
    });

    const result = await runText("Hi", deps);

    const [tern] = await deps.terns.byIds([result.ternId]);
    expect(tern?.configVersion).toBe("1.0.0");
    expect(tern?.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC2: the same version with other content is drift; snapshots are kept", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());

    expect(await store.rememberConfig("b", "1.0.0", "h1", "{a}")).toEqual({ drift: false });
    expect(await store.rememberConfig("b", "1.0.0", "h1", "{a}")).toEqual({ drift: false });
    expect(await store.rememberConfig("b", "1.0.0", "h2", "{b}")).toEqual({ drift: true });
    expect((await store.configSnapshots("b", "1.0.0")).map((s) => s.hash)).toEqual(["h1", "h2"]);
  });

  it("AC4: a 12-character hash from before canonical JSON is not comparable — no drift", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());

    await store.rememberConfig("b", "1.0.0", "a".repeat(12), "{old}");
    expect(await store.rememberConfig("b", "1.0.0", "b".repeat(64), "{new}")).toEqual({
      drift: false,
    });
    expect(await store.rememberConfig("b", "1.0.0", "c".repeat(64), "{newer}")).toEqual({
      drift: true,
    });
  });

  it("AC2: a config changed without a version bump warns on start", async () => {
    const env = { OPENROUTER_API_KEY: "k" };
    const base = await workflowOf(TestWorkflow);
    const providerFetch = providerStub([], [{ id: "test/researcher" }, { id: "test/coder" }]).fetch;
    // the records outlive the app instance: a durable repository both starts share
    const infrastructure = {
      ...standaloneInfrastructure(base, {}),
      records: new TernStoreRecordRepository(createSqliteTernStore(":memory:", () => new Date())),
    };
    const options = { processEnv: env, providerFetch };
    const first = await createWorkflowDeps(base, options, { infrastructure });
    await first.close();
    const changed = {
      ...base,
      prompts: { ...base.prompts, "coder-agent": "A different coder prompt." },
    };

    const second = await createWorkflowDeps(changed, options, { infrastructure });
    await second.close();

    expect(first.warnings).toEqual([]);
    expect(second.warnings[0]).toMatch(
      /config "test-workflow" 1\.0\.0 changed without a version bump \(hash [0-9a-f]{8}\)$/,
    );
  });
});
