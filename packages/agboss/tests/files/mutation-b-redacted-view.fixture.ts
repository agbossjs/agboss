/** What the tests of the redacted view (#1269) are built from: a batch with a redactor and a mask that are told what to do. */
import type { FileContent } from "../../src/files/file-bytes.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import type { FileMask } from "../../src/files/file-mask.js";
import type { RedactionResult, RedactionPlan } from "../../src/files/file-redactor.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { NO_FILES, type FileBatch, type FileRuntime } from "../../src/files/visit-files.js";
import type { A2AFileRepository } from "../../src/infrastructure/a2a-file.repository.js";
import { InlineA2AFileRepository } from "../../src/infrastructure/a2a-file.repository.js";
import { PiiKind } from "../../src/pii/kinds.js";
import type { PiiRefusedError } from "../../src/pii/errors.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { PNG_BYTES } from "./reader.factory.js";

export const AGENT = "reader-agent";
export const OWNER = "owner-1";
export const TENANT = "tenant-1";
export const NOW = new Date("2026-01-02T03:04:05.000Z");

export const png = (bytes: Uint8Array = PNG_BYTES, filename?: string): FileContent => ({
  mediaType: "image/png",
  ...(filename === undefined ? {} : { filename }),
  bytes,
  sha256: sha256Of(bytes),
});

/** A png of exactly `size` bytes. */
export const pngOfSize = (size: number, filename?: string): FileContent =>
  png(Buffer.concat([PNG_BYTES, Buffer.alloc(size - PNG_BYTES.byteLength)]), filename);

export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export interface RuntimeOver {
  readonly store?: A2AFileRepository;
  readonly supports?: (mediaType: string) => boolean;
  readonly redact?: (file: FileContent, plan: RedactionPlan) => Promise<RedactionResult>;
  readonly maxFileSize?: number;
  readonly sendsValues?: boolean;
}

export function runtimeOf(over: RuntimeOver = {}): FileRuntime {
  const store = over.store ?? new InlineA2AFileRepository();
  return {
    agent: AGENT,
    settings: {
      ...resolvedFilesOf({
        agent: ModelFiles.of({ views: [FileView.Redacted] }).options,
        defaults: undefined,
        skills: [],
        a2aFiles: undefined,
        hasPiiPolicy: true,
      }),
      maxFileSize: over.maxFileSize ?? megabytes(1),
      redactionSendsValues: over.sendsValues ?? false,
    },
    maxResultSize: kilobytes(8),
    context: () => ({
      store,
      tenantId: TENANT,
      ownerId: OWNER,
      signal: new AbortController().signal,
      clock: new VirtualClock(NOW),
      transport: () => Promise.reject(new Error("no network")),
      allowedOrigins: [],
      fetchTimeout: seconds(1),
      maxFileSize: megabytes(1),
    }),
    transcribe: () => Promise.reject(new Error("no transcription")),
    transcriberKey: () => "t",
    supportsRedaction: over.supports ?? ((mediaType) => mediaType === "image/png"),
    redact: over.redact ?? ((file) => Promise.resolve({ file, found: [] })),
    threadOwners: () => Promise.resolve([]),
    redactorKey: () => "rk",
  };
}

export interface MaskOver {
  readonly kinds?: readonly PiiKind[];
  readonly values?: readonly string[];
  readonly blocked?: readonly PiiKind[];
  readonly isModelChecked?: boolean;
  readonly refusal?: PiiRefusedError;
}

/** A mask that names what it is told, and records the kinds it was asked to refuse. */
export function maskOf(over: MaskOver = {}): FileMask & { readonly refusedFor: PiiKind[] } {
  const refusedFor: PiiKind[] = [];
  return {
    refusedFor,
    policyHash: "policy",
    known: {},
    mask: () => Promise.reject(new Error("no masking")),
    redaction: {
      kinds: over.kinds ?? [PiiKind.CardNumber],
      values: over.values ?? [],
      blocked: over.blocked ?? [],
      isModelChecked: over.isModelChecked ?? false,
    },
    redactionDigestOf: (sent) => `digest(${sent.join("|")})`,
    maskCacheKeyOf: (text) => `key(${text})`,
    refusalForKind: (kind) => {
      refusedFor.push(kind);
      return Promise.resolve(over.refusal);
    },
  };
}

export function batchOf(
  runtime: FileRuntime,
  mask: FileMask | undefined,
  cache: Record<string, string> = {},
  beforeModelCall: () => void = () => undefined,
): FileBatch {
  return { runtime, files: [], tally: NO_FILES, cache, first: 1, mask, beforeModelCall };
}

/** What a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}
