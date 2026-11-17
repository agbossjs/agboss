/**
 * #1269: the built-in image redactor needs the optional peer dependency `sharp`: the start rule when it
 * does not resolve — and no rule for an application that lists its own redactor.
 */
import { describe, expect, it, vi } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { nameOf } from "../../src/components/name-of.js";
import { FileRedactor } from "../../src/files/file-redactor.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import {
  Injectable,
  PiiAction,
  PiiFileAction,
  PiiKind,
  PiiPolicy,
  pii,
  type RedactionResult,
} from "../../src/index.js";
import type { RuleViolation } from "../../src/graph/rule-error.js";
import { readerApplication, type ReaderOptions } from "./reader.factory.js";

vi.mock("../../src/files/sharp-check.js", () => ({ isSharpResolvable: () => false }));

@PiiPolicy({
  name: "sharp-cards-pii-policy",
  description: "Hides cards",
  rules: [pii(PiiKind.CardNumber, PiiAction.replaceWithKind())],
  files: PiiFileAction.Mask,
})
class CardsPolicy {}

@Injectable()
class PngRedactor extends FileRedactor {
  supports(mediaType: string): boolean {
    return mediaType === "image/png";
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked"));
  }
}

async function thrownBy(options: ReaderOptions) {
  const app = readerApplication({
    files: ModelFiles.of({ views: [FileView.Redacted], allowedMediaTypes: ["image/png"] }),
    piiPolicies: [CardsPolicy],
    ...options,
  });
  const failure = await applicationOf(app.Application).then(
    () => undefined,
    (error: unknown) => error,
  );
  const violations: unknown =
    failure instanceof Error ? Reflect.get(failure, "violations") : undefined;
  const found = Array.isArray(violations)
    ? violations.map((item: RuleViolation) => ({
        code: item.code,
        message: item.message,
        nodes: item.nodes,
      }))
    : [];
  return { name: nameOf(app.Agent), found };
}

describe("the built-in image redactor needs sharp", () => {
  it("without it, no start: the built-in cannot redact", async () => {
    const { name, found } = await thrownBy({});

    expect(found).toEqual([
      {
        code: "files.invalid-setting",
        message: `${name}: files — the built-in image redactor needs the optional peer dependency sharp (npm i sharp), or list your own FileRedactor`,
        nodes: [name],
      },
    ]);
  });

  it("an application with its own redactor needs no sharp", async () => {
    const { found } = await thrownBy({ providers: [PngRedactor] });

    expect(found).toEqual([]);
  });
});
