/**
 * #1366: the run report of a trusted MCP call — signed with the application's `mesh.signingKey`, it names who issued it,
 * which execution, what it spent (what a trusted caller charges from), the call's body hash and when; none for a call
 * that is not trusted or an application that signs nothing. Each fact on its own, over the fakes it reads.
 */
import { describe, expect, it } from "vitest";
import { runReportMetaOf } from "../../src/mcp/mcp-run-report.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { readJws } from "../../src/mesh/mesh-jws.js";
import { meshKeyPair } from "../a2a/fixtures/mesh-keys.js";

const NOW = new Date("2026-03-04T05:06:07.000Z");
const KEY = "agboss.dev/report";

/** An application whose mesh settings are these keys. */
function appWith(keys: MeshSettings["keys"] | undefined): object {
  const app = {};
  const settings =
    keys === undefined
      ? undefined
      : { application: "billing-application", keys, clock: { now: () => NOW } };
  rememberMeshSettings(app, () => settings as never);
  return app;
}

const call = (bodyHash: string | undefined) =>
  ({ args: {}, signal: new AbortController().signal, bodyHash }) as never;

const result = { executionId: "exec-7", spend: { totalUsd: 0.0125 } } as never;

describe("#1366: the run report of a trusted call", () => {
  it("names the issuer, the execution, what it spent, the body it answers and when", () => {
    const { privateKey } = meshKeyPair();

    const meta = runReportMetaOf(
      appWith({ signingKey: privateKey, peers: new Map() }),
      call("sha256:ab"),
      result,
    );

    expect(readJws(meta?.[KEY])?.payload).toMatchObject({
      schema: 1,
      issuer: "billing-application",
      executionId: "exec-7",
      spend: { total: "0.0125", currency: "USD" },
      bodyHash: "sha256:ab",
      issuedAt: NOW.toISOString(),
    });
    expect(readJws(meta?.[KEY])?.signed).toBeDefined();
  });

  it("is none for an application with no mesh settings", () => {
    expect(runReportMetaOf(appWith(undefined), call("sha256:ab"), result)).toBeUndefined();
  });

  it("is none for an application that signs nothing", () => {
    expect(
      runReportMetaOf(appWith({ peers: new Map() }), call("sha256:ab"), result),
    ).toBeUndefined();
  });

  it("is none for a call with no trusted body hash", () => {
    const { privateKey } = meshKeyPair();

    expect(
      runReportMetaOf(
        appWith({ signingKey: privateKey, peers: new Map() }),
        call(undefined),
        result,
      ),
    ).toBeUndefined();
  });
});
