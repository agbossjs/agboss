/**
 * #860 (mutation shard `a2a-direct`): a completed direct reply as the wire shows it — for a trusted
 * caller (its message's `bodyHash` kept) of an application that signs, the run report over what the
 * run spent, bound to that hash and dated by the reply; none without the hash or without a key; the
 * stored files the reply could not serve counted in `missingFiles`.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { wireReplyOf } from "../../../src/a2a/server/a2a-direct-view.js";
import type { TaskViewParts } from "../../../src/a2a/server/a2a-task-view.js";
import { InlineA2AFileRepository } from "../../../src/infrastructure/a2a-file.repository.js";
import {
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
} from "../../../src/infrastructure/a2a-direct-message.repository.js";
import { verifiedRunReportOf } from "../../../src/mesh/mesh-report.js";
import { seconds } from "../../../src/units/index.js";
import { NINE } from "../server/support/unit-parts.js";
import { acceptedMessage, DIRECT_SKILL } from "./support/direct-parts.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const COMPLETED_AT = new Date(NINE.getTime() + seconds(3));

const completed = (overrides: Partial<A2ADirectMessageRecord> = {}): A2ADirectMessageRecord => ({
  ...acceptedMessage({ meshBodyHash: "body-hash-1" }),
  state: A2ADirectMessageState.Completed,
  reply: { finish: "unit-workflow-finish", output: { total: 3 }, spentUsd: 0.25 },
  completedAt: COMPLETED_AT,
  ...overrides,
});

const viewParts = (signs: boolean, skill = DIRECT_SKILL): TaskViewParts => ({
  skills: [skill],
  mesh: {
    application: "unit-application",
    keys: { peers: new Map(), ...(signs ? { signingKey: privateKey } : {}) },
  },
  files: { store: new InlineA2AFileRepository() },
});

const meshOf = async (message: A2ADirectMessageRecord, signs: boolean) =>
  (await wireReplyOf(message, viewParts(signs))).metadata?.[A2A_MESH_EXTENSION] as
    { readonly report: unknown } | undefined;

describe("#860: a direct reply's run report", () => {
  it("of a trusted caller: signed by the application over what the run spent, bound to the body hash, dated by the reply", async () => {
    const mesh = await meshOf(completed(), true);

    const report = verifiedRunReportOf(
      mesh?.report,
      new Map([["unit-application", publicKey]]),
      "body-hash-1",
    );

    expect(report).toEqual({
      schema: 1,
      issuer: "unit-application",
      executionId: "run-lost",
      spend: { total: "0.25", currency: "USD" },
      bodyHash: "body-hash-1",
      issuedAt: COMPLETED_AT.toISOString(),
    });
  });

  it("none for a caller that signed nothing, none from an application without a key", async () => {
    const untrusted = completed();
    Reflect.deleteProperty(untrusted, "meshBodyHash");

    expect([await meshOf(untrusted, true), await meshOf(completed(), false)]).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("#860: a direct reply's files", () => {
  it("a stored file it cannot serve is counted in missingFiles", async () => {
    const skill = {
      ...DIRECT_SKILL,
      outputs: [
        {
          ...DIRECT_SKILL.outputs[0],
          finish: "unit-workflow-finish",
          fileFields: [{ name: "report", isList: false, isOptional: false }],
          hasData: false,
        },
      ] as typeof DIRECT_SKILL.outputs,
    };
    const lost = { mediaType: "text/plain", fileId: "gone.0", sha256: "00", sizeBytes: 1 };
    const message = completed({
      reply: { finish: "unit-workflow-finish", output: { report: lost }, spentUsd: 0 },
    });

    const shown = await wireReplyOf(message, viewParts(false, skill));

    expect(shown.metadata?.[A2A_SKILLS_EXTENSION]).toEqual({
      finish: "unit-workflow-finish",
      missingFiles: 1,
    });
  });
});
