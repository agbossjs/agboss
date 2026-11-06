/**
 * #802 AC3: `VCRMode`, the old casing of `VcrMode`, still compiles wherever 0.1.0's enum did — as a
 * value, as the type, and a member as a type. Compiled from source text: the test names the
 * deprecated alias only inside a string, as a user's file would.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

const entry = new URL("../../src/testing/index.ts", import.meta.url).pathname;

const USER_FILE = `
import { VCRMode, VcrMode, type VcrConfig } from ${JSON.stringify(entry.replace(/\.ts$/, ".js"))};
const config: VcrConfig = { cassetteName: "x", mode: VCRMode.REPLAY };
const typed: VCRMode = VcrMode.AUTO;
const member: VCRMode.REPLAY = VcrMode.REPLAY;
const members: VCRMode.RECORD | VCRMode.RECORD_STALE = VCRMode.RECORD;
const back: VcrMode = typed;
export const all = [config, member, members, back];
`;

const file = `${new URL("./", import.meta.url).pathname}__vcr-mode-user.ts`;
const options: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

/** What an editor marks deprecated in the user's file: the names it strikes through. */
function deprecatedIn(text: string): readonly string[] {
  const service = ts.createLanguageService({
    getScriptFileNames: () => [file],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const content = name === file ? text : ts.sys.readFile(name);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    fileExists: (name) => name === file || ts.sys.fileExists(name),
    readFile: (name) => (name === file ? text : ts.sys.readFile(name)),
  });
  return service
    .getSuggestionDiagnostics(file)
    .filter((found) => found.reportsDeprecated === true)
    .map((found) => text.slice(found.start, found.start + found.length));
}

function diagnosticsOf(text: string): readonly string[] {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === file ? text : readFile(name));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === file || fileExists(name);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((found) => ts.flattenDiagnosticMessageText(found.messageText, "\n"));
}

describe("#802 AC3: the deprecated VCRMode alias", () => {
  it("compiles as a value, as the type and with a member as a type", () => {
    expect(diagnosticsOf(USER_FILE)).toEqual([]);
  }, 60_000);

  it("an editor marks every use of VCRMode deprecated, never VcrMode", () => {
    const marked = deprecatedIn(USER_FILE);

    expect(marked.length).toBeGreaterThan(0);
    expect(new Set(marked)).toEqual(new Set(["VCRMode"]));
  }, 60_000);

  it("the check bites: a name the alias does not have fails to compile", () => {
    expect(diagnosticsOf(`${USER_FILE}\nconst none: VCRMode.NOPE = VcrMode.AUTO;`)).not.toEqual([]);
  }, 60_000);
});
