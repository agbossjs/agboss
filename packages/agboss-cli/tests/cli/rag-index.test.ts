import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

/** #268 AC12: `agboss rag index` covers every knowledge base of the application. */

const NOTES = fixture("cli/rag.workflow.ts");

describe("#268 AC12: agboss rag index over the application", () => {
  it("every knowledge base once — one shared by two agents too; one without an index says so", async () => {
    const call = await agboss(["rag", "index", "--application", NOTES]);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout.trimEnd().split("\n")).toEqual([
      "notes-rag: 2 documents, 3 chunks, 1 unchanged · $0.000500",
      "handbook-rag: no index to build (the connector has none)",
    ]);
  });

  it("--rag <full name>: only that one, as data with --json", async () => {
    const call = await agboss([
      "rag",
      "index",
      "--application",
      NOTES,
      "--rag",
      "notes-rag",
      "--json",
    ]);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        indexed: [{ name: "notes-rag", documents: 2, chunks: 3, skipped: 1, costUsd: 0.0005 }],
      },
    });
  });

  it("an unknown --rag: exit 2, a hint and the list; nothing is indexed", async () => {
    const call = await agboss(["rag", "index", "--application", NOTES, "--rag", "notes"]);

    expect(call.code).toBe(2);
    expect(call.stdout).toBe("");
    expect(call.stderr).toContain(
      'Knowledge base "notes" not found. Did you mean "notes-rag"? The knowledge bases: notes-rag, handbook-rag',
    );
  });

  it("an application without knowledge bases says so", async () => {
    const call = await agboss([
      "rag",
      "index",
      "--application",
      fixture("test-workflow/test.workflow.ts"),
    ]);

    expect(call.code).toBe(0);
    expect(call.stdout).toBe('No knowledge bases in "test-application".\n');
  });

  it('"agboss rag" needs its subcommand: exit 2; the old rag:index is unknown', async () => {
    const bare = await agboss(["rag", "--application", NOTES]);
    const old = await agboss(["rag:index", "--application", NOTES]);

    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('expected "agboss rag index …"');
    expect(old.code).toBe(2);
    expect(old.stderr).toContain('unknown command "rag:index"');
  });
});
