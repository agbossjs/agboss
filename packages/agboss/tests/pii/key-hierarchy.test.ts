/**
 * #1269 — the PII key hierarchy: every digest made from the application's PII key is an HMAC under a
 * key of its own purpose, derived by HKDF-SHA256 (`agboss/pii-key-hierarchy` salt, the purpose's label as
 * `info`). A token, a policy set's hash, a redacted copy's key and a masked text's key of one input are
 * four different digests; none of them is a plain hash; the one key an execution keeps in its checkpoint
 * (#334) roots its tokens only, so no digest kept beside it is computable from it; and what 0.1.0 kept —
 * its token maps, its loops' masked texts — is read as it was or never mistaken for the new scheme's.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { fileMaskOf } from "../../src/files/file-mask.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { NO_FILES, filePiecesOf, type FileRuntime } from "../../src/files/visit-files.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { PiiAction } from "../../src/pii/actions.js";
import { PiiKeyPurpose, purposeDigestOf, purposeKeyOf } from "../../src/pii/key-hierarchy.js";
import { maskForModel } from "../../src/pii/model-boundary.js";
import { PiiPolicySet, type SensitiveValue } from "../../src/pii/policy-set.js";
import { normalisedValue, revealedText, tokenOf } from "../../src/pii/tokens.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { inline, PNG_BYTES } from "../files/reader.factory.js";
import { NO_REDACTION } from "../files/runtime-parts.js";

const ROOT = "application-pii-key";
const SALT = "agboss/pii-key-hierarchy";

/** The purpose key as RFC 5869 makes it, computed here from node:crypto alone. */
const hkdfKey = (root: string, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", root, SALT, info, 32));
const hmacHex = (key: Buffer | string, text: string): string =>
  createHmac("sha256", key).update(text).digest("hex");
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

const DANA: SensitiveValue = {
  value: "dana@example.com",
  label: "email",
  action: PiiAction.tokenize(),
};

describe("#1269: one key per purpose, derived by HKDF-SHA256", () => {
  it("each purpose has a label of its own, versioned", () => {
    const labels = Object.values(PiiKeyPurpose);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      "agboss/pii/pseudonym/v2",
      "agboss/pii/policy-hash/v2",
      "agboss/files/cache-key/v2",
      "agboss/pii/mask-cache/v2",
      "agboss/pii/key-id/v2",
    ]);
  });

  it("a purpose key is HKDF-SHA256 of the root under the hierarchy's salt and the purpose's label", () => {
    for (const purpose of Object.values(PiiKeyPurpose))
      expect(purposeKeyOf(ROOT, purpose).equals(hkdfKey(ROOT, purpose))).toBe(true);
    expect(purposeKeyOf(ROOT, PiiKeyPurpose.Pseudonym)).toHaveLength(32);
    expect(purposeKeyOf("another-root", PiiKeyPurpose.Pseudonym).toString("hex")).not.toBe(
      purposeKeyOf(ROOT, PiiKeyPurpose.Pseudonym).toString("hex"),
    );
  });

  it("a token is the HMAC of the normalised value under the pseudonym key — never under the root itself", () => {
    const token = tokenOf("email", " Dana@Example.com ", ROOT, {});
    const pseudonym = hmacHex(hkdfKey(ROOT, "agboss/pii/pseudonym/v2"), "dana@example.com");

    expect(normalisedValue("email", " Dana@Example.com ")).toBe("dana@example.com");
    expect(token).toBe(`<email:${pseudonym.slice(0, 6)}>`);
    // the 0.1.0 scheme: the root as the HMAC key
    expect(token).not.toBe(`<email:${hmacHex(ROOT, "dana@example.com").slice(0, 6)}>`);
  });

  it("two uses with the same input give different outputs: token, policy hash, redaction key, mask key", () => {
    const text = "dana@example.com";
    const set = new PiiPolicySet([], ROOT);
    const digests = [
      purposeDigestOf(ROOT, PiiKeyPurpose.Pseudonym, text),
      purposeDigestOf(ROOT, PiiKeyPurpose.PolicyHash, text),
      purposeDigestOf(ROOT, PiiKeyPurpose.FileCache, text),
      purposeDigestOf(ROOT, PiiKeyPurpose.MaskCache, text),
      purposeDigestOf(ROOT, PiiKeyPurpose.KeyId, text),
      hmacHex(ROOT, text),
      sha256Hex(text),
    ];

    expect(new Set(digests).size).toBe(digests.length);
    const token = tokenOf("email", text, ROOT, {}).slice("<email:".length, -1);
    const maskKey = set.maskCacheKeyOf(text, true).slice("in:".length);
    expect(maskKey).toBe(digests[3]);
    expect(maskKey.startsWith(token)).toBe(false);
    expect(set.redactionDigestOf([text]).startsWith(token)).toBe(false);
    expect(set.redactionDigestOf([text])).not.toBe(maskKey.slice(0, 32));
  });
});

describe("#1269: the policy set's hash is an HMAC, no oracle over its values", () => {
  const withDana = new PiiPolicySet([], ROOT).withValues([DANA]);

  it("is the HMAC of its policies, its token key's id and its values under the policy-hash key", () => {
    const keyId = hmacHex(hkdfKey(ROOT, "agboss/pii/key-id/v2"), "");
    const text = JSON.stringify([[], keyId, [["email", DANA.value, DANA.action]]]);

    expect(withDana.fingerprint).toBe(
      hmacHex(hkdfKey(ROOT, "agboss/pii/policy-hash/v2"), text).slice(0, 32),
    );
  });

  it("is not a plain SHA-256 of what it covers (the 0.1.0 scheme), nor of the values alone", () => {
    const old = JSON.stringify([[], ROOT, [["email", DANA.value, DANA.action]]]);

    expect(withDana.fingerprint).not.toBe(sha256Hex(old).slice(0, 16));
    expect(withDana.fingerprint.startsWith(sha256Hex(old).slice(0, 16))).toBe(false);
    expect(withDana.fingerprint).not.toContain(sha256Hex(DANA.value).slice(0, 16));
  });

  it("changes with the root, the values and the token key; equal sets hash equal", () => {
    const again = new PiiPolicySet([], ROOT).withValues([DANA]);
    const otherRoot = new PiiPolicySet([], "another-root").withValues([DANA]);
    const otherValue = new PiiPolicySet([], ROOT).withValues([{ ...DANA, value: "avi@x.io" }]);
    const ownTokens = withDana.withFieldKey("execution-own-key");

    expect(again.fingerprint).toBe(withDana.fingerprint);
    expect(otherRoot.fingerprint).not.toBe(withDana.fingerprint);
    expect(otherValue.fingerprint).not.toBe(withDana.fingerprint);
    expect(ownTokens.fingerprint).not.toBe(withDana.fingerprint);
  });
});

describe("#1269: an execution's own key (#334) roots its tokens only", () => {
  const SEED = "execution-own-key";
  const under = (root: string) => new PiiPolicySet([], root).withValues([DANA]).withFieldKey(SEED);

  it("its tokens are made under it", () => {
    expect(tokenOf("email", DANA.value, under(ROOT).fieldKey, {})).toBe(
      `<email:${hmacHex(hkdfKey(SEED, "agboss/pii/pseudonym/v2"), DANA.value).slice(0, 6)}>`,
    );
  });

  it("no kept digest is computable from it: under another root they all change, the seed the same", () => {
    const one = under(ROOT);
    const other = under("another-root");

    expect(other.fingerprint).not.toBe(one.fingerprint);
    expect(other.redactionDigestOf([DANA.value])).not.toBe(one.redactionDigestOf([DANA.value]));
    expect(other.maskCacheKeyOf(DANA.value, true)).not.toBe(one.maskCacheKeyOf(DANA.value, true));
    // and none is what the seed would make as a root
    const seedRooted = new PiiPolicySet([], SEED).withValues([DANA]);
    expect(one.fingerprint).not.toBe(seedRooted.fingerprint);
    expect(one.redactionDigestOf([DANA.value])).not.toBe(
      seedRooted.redactionDigestOf([DANA.value]),
    );
    expect(one.maskCacheKeyOf(DANA.value, true)).not.toBe(
      seedRooted.maskCacheKeyOf(DANA.value, true),
    );
  });

  it("another execution's key under the same root: the same redaction and mask keys (no token in them)", () => {
    const another = new PiiPolicySet([], ROOT).withValues([DANA]).withFieldKey("another-seed");

    expect(another.redactionDigestOf([DANA.value])).toBe(
      under(ROOT).redactionDigestOf([DANA.value]),
    );
    expect(another.maskCacheKeyOf("x", false)).toBe(under(ROOT).maskCacheKeyOf("x", false));
  });

  it("withValues keeps the root of a set whose tokens have the execution's key", () => {
    const later = new PiiPolicySet([], ROOT).withFieldKey(SEED).withValues([DANA]);

    expect(later.fingerprint).toBe(under(ROOT).fingerprint);
    expect(later.redactionDigestOf(["a"])).toBe(
      new PiiPolicySet([], ROOT).redactionDigestOf(["a"]),
    );
  });
});

let transcriptions = 0;

const runtime: FileRuntime = {
  agent: "a-agent",
  settings: resolvedFilesOf({
    agent: ModelFiles.of({ views: [FileView.Transcription] }).options,
    defaults: undefined,
    skills: [],
    a2aFiles: undefined,
    hasPiiPolicy: true,
  }),
  maxResultSize: kilobytes(8),
  ...NO_REDACTION,
  transcriberKey: () => "t",
  transcribe: () => {
    transcriptions += 1;
    return Promise.resolve({ text: "write to dana@example.com" });
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

const piecesWith = (cache: Record<string, string>, set: PiiPolicySet) =>
  filePiecesOf({
    runtime,
    files: [{ descriptor: inline(PNG_BYTES, "image/png", "a.png"), field: "f", producer: "p" }],
    tally: NO_FILES,
    cache,
    first: 1,
    mask: fileMaskOf(set, {}),
    beforeModelCall: () => undefined,
  });

describe("#1269: a cached transcription beside the execution's own key is keyed under the root", () => {
  const seeded = (root: string) =>
    new PiiPolicySet([], root).withValues([DANA]).withFieldKey("execution-own-key");

  it("the kept key holds the root's policy hash, not one the checkpoint's key makes", async () => {
    transcriptions = 0;
    const built = await piecesWith({}, seeded(ROOT));
    const [key] = Object.keys(built.transcripts);

    expect(key?.endsWith(`:${seeded(ROOT).fingerprint}`)).toBe(true);
    expect(key).not.toContain(
      new PiiPolicySet([], "execution-own-key").withValues([DANA]).fingerprint,
    );
    expect(Object.values(built.transcripts).join()).not.toContain(DANA.value);
  });

  it("under another root (another instance, no piiKeyField) the kept entry is not reused", async () => {
    transcriptions = 0;
    const first = await piecesWith({}, seeded(ROOT));
    const same = await piecesWith(first.transcripts, seeded(ROOT));
    await piecesWith(first.transcripts, seeded("another-instance-key"));

    expect(Object.keys(same.transcripts)).toEqual([]);
    expect(transcriptions).toBe(2);
  });
});

describe("#1269: what 0.1.0 kept", () => {
  const set = new PiiPolicySet([], ROOT).withValues([DANA]);
  const v1Token = `<email:${hmacHex(ROOT, DANA.value).slice(0, 6)}>`;

  it("a 0.1.0 token in a kept token map is still revealed: tokens are looked up, never derived again", () => {
    const revealed = revealedText(`write to ${v1Token}`, { [v1Token]: DANA.value });

    expect(revealed).toEqual({ text: `write to ${DANA.value}`, unknownTokens: [] });
  });

  it("a new token never takes a 0.1.0 token's place for another value", () => {
    const fresh = tokenOf("email", DANA.value, ROOT, {});
    const taken = { [fresh]: "someone-else@example.com" };

    const longer = tokenOf("email", DANA.value, ROOT, taken);

    expect(longer).not.toBe(fresh);
    expect(longer.startsWith(fresh.slice(0, -1))).toBe(true);
  });

  it("a loop's 0.1.0 masked text (by plain SHA-256) is not reused: the text is masked again in the new tokens", async () => {
    const text = `write to ${DANA.value}`;
    const oldCache = { [`in:${sha256Hex(text)}`]: `write to ${v1Token}` };

    const request = await maskForModel(
      set,
      [new HumanMessage(text)],
      { [v1Token]: DANA.value },
      oldCache,
    );

    const fresh = tokenOf("email", DANA.value, ROOT, { [v1Token]: DANA.value });
    expect(request.messages[0]?.content).toBe(`write to ${fresh}`);
    expect(request.messages[0]?.content).not.toContain(v1Token);
    expect(Object.keys(request.cache)).toEqual([set.maskCacheKeyOf(text, true)]);
  });

  it("a masked text kept under the new key is reused", async () => {
    const text = `write to ${DANA.value}`;
    const cache = { [set.maskCacheKeyOf(text, true)]: "kept masked text" };

    const request = await maskForModel(set, [new HumanMessage(text)], {}, cache);

    expect(request.messages[0]?.content).toBe("kept masked text");
  });
});
