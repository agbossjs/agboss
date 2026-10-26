import { toolOf } from "@agboss/core/testing";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/helpers/boards.helper.js";
import { matchScore } from "../src/helpers/greenhouse.helper.js";
import { MAX_RESUME_CHARS } from "../src/helpers/resume.helper.js";
import { ReadResume } from "../src/tools/read-resume.tool.js";
import { ResumeReader } from "../src/services/resume-reader.service.js";

async function fileWith(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "resume-")), name);
  await writeFile(path, content);
  return path;
}

describe("read-resume-tool", () => {
  it("reads Markdown and text", async () => {
    const tool = toolOf(new ReadResume(new ResumeReader()));

    const result = await tool.invoke({
      path: await fileWith("cv.md", "# Me\nTypeScript,   Kafka"),
    });

    expect(result).toMatchObject({
      kind: "ok",
      value: { format: "markdown", text: "# Me\nTypeScript, Kafka", truncated: false },
    });
  });

  it("reads PDF through the extractor and truncates long text", async () => {
    const tool = toolOf(
      new ReadResume(new ResumeReader(() => Promise.resolve("x".repeat(MAX_RESUME_CHARS + 5)))),
    );

    const result = await tool.invoke({ path: await fileWith("cv.pdf", new Uint8Array([1, 2])) });

    expect(result).toMatchObject({ kind: "ok", value: { format: "pdf", truncated: true } });
    expect(result.kind === "ok" && result.value.text.length).toBe(MAX_RESUME_CHARS);
  });

  it("reports unsupported formats and missing files to the model", async () => {
    const tool = toolOf(new ReadResume(new ResumeReader()));

    const docx = await tool.invoke({ path: await fileWith("cv.docx", "x") });
    expect(docx.kind === "error" && docx.message).toContain("Unsupported");
    expect((await tool.invoke({ path: "/nope/cv.pdf" })).kind).toBe("error");
  });
});

describe("greenhouse helpers", () => {
  it("turns escaped Greenhouse HTML into text", () => {
    expect(htmlToText("&lt;p&gt;Node.js &amp;amp; &lt;b&gt;Kafka&lt;/b&gt;&lt;/p&gt;")).toBe(
      "Node.js & Kafka",
    );
  });

  it("scores by the share of skills mentioned, as whole words", () => {
    expect(
      matchScore(
        ["TypeScript", "Kafka", "Go", "Java"],
        "We use typescript and Kafka; JavaScript too",
      ),
    ).toEqual({
      score: 50,
      matched: ["TypeScript", "Kafka"],
    });
    expect(matchScore([], "anything").score).toBe(0);
  });
});

describe("read-resume-tool near-miss paths", () => {
  it("reads the one loosely matching file when the model mangled the name", async () => {
    const real = await fileWith("Pavel__Ravvich_CV.md", "# CV\nJava");
    const mangled = real.replace("Pavel__Ravvich_CV.md", "pavel__ravvich__cv.md");

    const result = await toolOf(new ReadResume(new ResumeReader())).invoke({ path: mangled });

    expect(result).toMatchObject({
      kind: "ok",
      value: { path: real, requestedPath: mangled, text: "# CV\nJava" },
    });
  });

  it("reports the folder's resume files when nothing matches, and a plain error for a missing folder", async () => {
    const real = await fileWith("cv.md", "x");
    const tool = toolOf(new ReadResume(new ResumeReader()));

    const other = await tool.invoke({ path: real.replace("cv.md", "resume.pdf") });
    const nowhere = await tool.invoke({ path: "/nope/nope/cv.pdf" });

    expect(other.kind === "error" && other.message).toContain("Files in that folder: cv.md");
    expect(nowhere.kind === "error" && nowhere.message).toContain("No such file or folder");
  });

  it("does not report a requested path when the exact file exists", async () => {
    const result = await toolOf(new ReadResume(new ResumeReader())).invoke({
      path: await fileWith("cv.txt", "x"),
    });

    expect(result.kind === "ok" && "requestedPath" in result.value).toBe(false);
  });
});
