/**
 * #1269: the schema of an agent's resolved files: every setting is there, and a value that is none is
 * refused.
 */
import { describe, expect, it } from "vitest";
import { AgentFilesSchema } from "../../src/files/files-schema.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";

const resolved = resolvedFilesOf({
  agent: {},
  defaults: undefined,
  skills: [],
  a2aFiles: undefined,
  hasPiiPolicy: false,
});

describe("AgentFilesSchema", () => {
  it("takes the resolved files of an agent as they are", () => {
    expect(AgentFilesSchema.parse(resolved)).toEqual(resolved);
  });

  it("refuses a setting that is missing or of another type, and a source that is none", () => {
    const { maxFiles: _dropped, ...missing } = resolved;

    expect(AgentFilesSchema.safeParse(missing).success).toBe(false);
    expect(AgentFilesSchema.safeParse({ ...resolved, maxFiles: "5" }).success).toBe(false);
    expect(AgentFilesSchema.safeParse({ ...resolved, sources: ["bogus"] }).success).toBe(false);
    expect(AgentFilesSchema.safeParse({ ...resolved, redactionValues: "maybe" }).success).toBe(
      false,
    );
    expect(AgentFilesSchema.safeParse(null).success).toBe(false);
  });
});
