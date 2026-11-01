/**
 * #118 AC5 (#115 correction 11): field metadata is there when the package is the `tsc` build and the
 * user's DTO is `tsc` output too — not only under esbuild (Vitest, tsx). Spawns Node on `dist`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

const dist = new URL("../../dist/dto/", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "agboss-dto-"));

/** A user's DTO module, compiled by `tsc` (its decorator emit), importing the built package. */
const source = `
import { Text, ListOf } from ${JSON.stringify(new URL("index.js", dist).href)};
import { jsonSchemaOf } from ${JSON.stringify(new URL("schema.js", dist).href)};

class Order {
  @Text({ prompt: "the order code" })
  code!: string;

  @ListOf(Text, { optional: true })
  notes?: string[];
}

console.log(JSON.stringify({ metadata: typeof (Symbol as { metadata?: symbol }).metadata, schema: jsonSchemaOf(Order) }));
`;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DTO metadata under the tsc build (#118)", () => {
  it("AC5: a tsc-compiled DTO loaded from dist has its fields in order", async () => {
    expect(existsSync(dist), "build the package first: npm run build").toBe(true);
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    });
    const file = join(dir, "order.mjs");
    writeFileSync(file, outputText);

    const run = await runNode([pathToFileURL(file).pathname]);

    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      metadata: "symbol",
      schema: {
        type: "object",
        properties: {
          code: { type: "string", description: "the order code" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["code"],
      },
    });
  });
});
