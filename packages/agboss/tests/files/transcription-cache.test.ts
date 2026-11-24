/**
 * #899 §7: the transcription cache — masked where a policy applies, keyed by the policies that masked it,
 * never reused across policy sets, executions or tenants; PII reads text only, never bytes.
 */
import { NO_REDACTION } from "./runtime-parts.js";
import { describe, expect, it } from "vitest";
import { fileMaskOf } from "../../src/files/file-mask.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { NO_FILES, filePiecesOf, type FileRuntime } from "../../src/files/visit-files.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { PiiAction, type AnyPiiAction } from "../../src/pii/actions.js";
import { PiiKind } from "../../src/pii/kinds.js";
import {} from "../../src/pii/pii-policy.decorator.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { inline, PNG_BYTES } from "./reader.factory.js";
import { DEFAULT_FILE_LIMITS } from "../../src/files/file-policy.js";

let transcriptions = 0;

const runtime: FileRuntime = {
  agent: "a-agent",
  settings: resolvedFilesOf({
    agent: ModelFiles.of({ views: [FileView.Transcription] }).options,
    defaults: undefined,
    limits: DEFAULT_FILE_LIMITS,
    hasPiiPolicy: true,
  }),
  maxResultSize: kilobytes(8),
  ...NO_REDACTION,
  transcriberKey: () => "t",
  transcribe: () => {
    transcriptions += 1;
    return Promise.resolve({ text: "card 4242 4242 4242 4242" });
  },
  context: () => ({
    store: new InMemoryFileRepository(new InMemoryDatabase()),
    tenantId: "t",
    ownerId: "o",
    signal: new AbortController().signal,
    clock: new VirtualClock(),
    transport: () => Promise.reject(new Error("no network")),
    allowedOrigins: [],
    fetchTimeout: seconds(1),
    maxFileSize: megabytes(1),
  }),
};

const policy = (name: string, action: AnyPiiAction = PiiAction.mask()) => {
  const meta: PiiPolicyMeta = {
    name,
    description: name,
    rules: [{ target: PiiKind.CardNumber, action }],
    deps: [],
  };
  return runtimePolicyOf({ meta, instance: {}, key: "k" });
};

const setOf = (...names: string[]) =>
  new PiiPolicySet(
    names.map((name) => policy(name)),
    "field-key",
  );

const batch = (cache: Record<string, string>, set: PiiPolicySet | undefined) => ({
  runtime,
  files: [{ descriptor: inline(PNG_BYTES, "image/png", "a.png"), field: "f", producer: "p" }],
  tally: NO_FILES,
  cache,
  first: 1,
  mask: fileMaskOf(set, {}),
  beforeModelCall: () => undefined,
});

describe("the cache key names the policies that masked the text", () => {
  it("a masked text is cached masked: the cache never holds the raw transcript", async () => {
    transcriptions = 0;

    const built = await filePiecesOf(batch({}, setOf("cards-pii-policy")));

    expect(Object.values(built.transcripts)).toEqual(["card <card-number>"]);
    expect(JSON.stringify(built)).toContain("<card-number>");
    expect(Object.values(built.transcripts).join()).not.toContain("4242");
  });

  it("the same policies reuse it; another set of policies makes its own, and never reads the first's", async () => {
    transcriptions = 0;
    const first = await filePiecesOf(batch({}, setOf("cards-pii-policy")));
    const same = await filePiecesOf(batch(first.transcripts, setOf("cards-pii-policy")));
    const other = await filePiecesOf(batch(first.transcripts, setOf("other-cards-pii-policy")));

    expect(transcriptions).toBe(2);
    expect(Object.keys(same.transcripts)).toEqual([]);
    const [firstKey] = Object.keys(first.transcripts);
    const [otherKey] = Object.keys(other.transcripts);
    expect(otherKey).not.toBe(firstKey);
  });

  it("a different key or other sensitive values is another set: its text is masked again", async () => {
    transcriptions = 0;
    const first = await filePiecesOf(batch({}, setOf("cards-pii-policy")));
    const rekeyed = new PiiPolicySet([policy("cards-pii-policy")], "another-key");

    await filePiecesOf(batch(first.transcripts, rekeyed));

    expect(transcriptions).toBe(2);
  });

  it("without policies the transcript is the cache's text as before, under no policy hash", async () => {
    transcriptions = 0;

    const built = await filePiecesOf(batch({}, undefined));

    expect(Object.values(built.transcripts)).toEqual(["card 4242 4242 4242 4242"]);
    expect(Object.keys(built.transcripts)[0]?.endsWith(":")).toBe(true);
  });

  it("a block rule in the transcript refuses before anything is cached or sent", async () => {
    transcriptions = 0;
    const blocking = new PiiPolicySet(
      [policy("blocking-pii-policy", PiiAction.block("No cards."))],
      "field-key",
    );

    await expect(filePiecesOf(batch({}, blocking))).rejects.toMatchObject({ code: "pii.refused" });
  });

  it("a fingerprint is stable for equal sets and differs for different ones", () => {
    expect(setOf("a-pii-policy").fingerprint).toBe(setOf("a-pii-policy").fingerprint);
    expect(setOf("a-pii-policy").fingerprint).not.toBe(setOf("b-pii-policy").fingerprint);
    expect(setOf("a-pii-policy").fingerprint).not.toBe(
      setOf("a-pii-policy", "b-pii-policy").fingerprint,
    );
  });
});
