import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RagMode } from "agboss";
import { workflowOf } from "agboss/testing";
import { JobScout } from "../src/job-scout.workflow.js";
import { NOTES_DIR } from "../src/config/paths.js";
import { CompanyNotes } from "../src/rag/company-notes.rag.js";

const signal = new AbortController().signal;

describe("company notes (knowledge base)", () => {
  it("AC3: finds the note about a company, with its file as the source", async () => {
    const notes = new CompanyNotes({
      folder: NOTES_DIR,
      dbFile: join(await mkdtemp(join(tmpdir(), "notes-")), "notes.sqlite"),
    });

    const retrieval = await notes.retrieve("Why is Fireblocks a fit for a backend engineer?", {
      topK: 3,
      signal,
    });

    expect(retrieval.results[0]?.source).toBe("fireblocks.md");
    expect(retrieval.results.map((result) => result.source)).not.toContain("readme.md");
  });

  it("AC3: the scout searches the notes itself (tool mode, 3 passages); the notes are marked as samples", async () => {
    const workflow = await workflowOf(JobScout);
    const index = await new CompanyNotes({
      folder: NOTES_DIR,
      dbFile: join(await mkdtemp(join(tmpdir(), "notes-")), "n.sqlite"),
    }).index();

    expect(workflow.config.agents["scout-agent"]?.rag).toEqual([
      { name: "company-notes-rag", mode: RagMode.Tool, topK: 3 },
    ]);
    expect(workflow.config.agents["scout-agent"]?.tools).toContain("search-company-notes-rag-tool");
    expect(index.documents).toBe(5);
  });
});
