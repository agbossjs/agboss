import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markChains, unmarkChains } from "../../src/scaffold/chains.js";
import { formatFiles } from "../../src/scaffold/format.js";

const root = mkdtempSync(join(tmpdir(), "agboss-chains-"));
const JOINED = "export const flow = [onStart(A).toAgent(B).toFinish(C)];\n";
const SPLIT = "export const flow = [\n  onStart(A)\n    .toAgent(B)\n    .toFinish(C),\n];\n";

const formatted = async (path: string, content: string): Promise<string> => {
  const [file] = await formatFiles(root, [{ path, content }]);
  return file?.content ?? "";
};

describe("#289: generated workflow modules keep one call per line", () => {
  it("a workflow module's chain is split one call per line, Prettier's layout otherwise", async () => {
    expect(await formatted("src/desk/desk.workflow.ts", JOINED)).toBe(SPLIT);
  });

  it("formatting a workflow module again changes nothing", async () => {
    expect(await formatted("src/desk/desk.workflow.ts", SPLIT)).toBe(SPLIT);
  });

  it("any other file is Prettier's alone: its short chains stay joined", async () => {
    expect(await formatted("src/desk/flow.ts", SPLIT)).toBe(JOINED);
  });

  it("calls on a new object, on a member and in an optional chain count; a plain member call does not", async () => {
    const text = "new F(a).g(); x.y.z(); a()?.b(); a.b();\n";

    expect(unmarkChains(markChains(text, "a.workflow.ts"))).toBe(
      "new F(a)\n.g(); x.y.z(); a()\n?.b(); a.b();\n",
    );
  });

  it("a comment between a call and the next one stays", async () => {
    const text = "export const x = onStart(A) // the start\n  .toFinish(C);\n";

    expect(await formatted("src/x.workflow.ts", text)).toBe(
      "export const x = onStart(A) // the start\n  .toFinish(C);\n",
    );
  });
});
