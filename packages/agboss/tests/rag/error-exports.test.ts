/**
 * #1226 follow-up: the errors the SQLite FTS connector throws are public: a caller catches them
 * from the `@agboss/core/rag` entry, with `instanceof`, not by the name in a message.
 */
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../src/core/errors.js";
import * as entry from "../../src/rag/index.js";
import {
  RagFts5UnavailableError as FtsUnavailable,
  RagIndexVersionError as IndexVersion,
} from "../../src/rag/sqlite-fts-schema.js";

describe("the rag entry exports the errors its connector throws", () => {
  it("RagFts5UnavailableError and RagIndexVersionError are the connector's own classes", () => {
    expect(entry.RagFts5UnavailableError).toBe(FtsUnavailable);
    expect(entry.RagIndexVersionError).toBe(IndexVersion);
  });

  it("an error thrown by the connector's schema is an instance of the exported class and of AGBossError", () => {
    const unavailable = new entry.RagFts5UnavailableError({ message: "no FTS5 here" });
    const version = new entry.RagIndexVersionError({ message: "a later index" });

    expect(unavailable).toBeInstanceOf(entry.RagFts5UnavailableError);
    expect(unavailable).toBeInstanceOf(AGBossError);
    expect(unavailable.code).toBe("rag.fts5-unavailable");
    expect(version).toBeInstanceOf(entry.RagIndexVersionError);
    expect(version).toBeInstanceOf(AGBossError);
    expect(version.code).toBe("rag.index-version");
    expect(unavailable).not.toBeInstanceOf(entry.RagIndexVersionError);
  });
});
