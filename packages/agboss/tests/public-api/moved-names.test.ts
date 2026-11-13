/**
 * #895: what the acceptance moved out of the public entries stays out. The names that moved to
 * `/internal` are not on the root (the committed report alone guarded that); the leaked wiring and
 * the pieces inlined into their options are named by no public entry; the type machinery lives in
 * one `@beta` namespace per entry, no longer in the entry's own namespace.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as internal from "../../src/internal.js";
import * as root from "../../src/index.js";
import * as dto from "../../src/dto/index.js";
import * as mcp from "../../src/mcp/index.js";
import * as models from "../../src/models/index.js";
import * as testing from "../../src/testing/index.js";

const API = join(import.meta.dirname, "../../api");
const SRC = join(import.meta.dirname, "../../src");
const reportOf = (name: string): string => readFileSync(join(API, `${name}.api.md`), "utf8");
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** The names a report declares at the top level, and those inside its `declare namespace`. */
function namesOf(report: string): { top: Set<string>; spaces: Map<string, string[]> } {
  const top = new Set<string>();
  for (const line of report.split("\n")) {
    const found = /^export (?:declare )?(?:abstract )?\w+ ([A-Za-z0-9_$]+)/.exec(line);
    if (found?.[1]) top.add(found[1]);
  }
  const spaces = new Map<string, string[]>();
  for (const block of report.matchAll(/^declare namespace (\w+) \{\n {4}export \{\n([^}]*)\}/gm))
    spaces.set(block[1] ?? "", words((block[2] ?? "").replaceAll(",", " ")));
  return { top, spaces };
}

describe("#895: the values that moved to /internal are not on the root", () => {
  const moved = ["loadWorkflow", "executeAgent", "resumeAgent", "withProfile", "resolveTools"];

  it.each([...moved, "executionVersions", "workflowOf", "toolOf"])("%s", (name) => {
    expect(internal).toHaveProperty(name);
    expect(root).not.toHaveProperty(name);
    expect(testing).not.toHaveProperty(name);
  });

  it("the type names that moved are in no root report line either", () => {
    const { top } = namesOf(reportOf("agboss"));
    const types = words(
      "AssembledWorkflow WorkflowServices AgentExecutionDeps AgentExecutionOptions ContinueOptions TreeResume",
    );
    for (const name of [...moved, "executionVersions", ...types])
      expect(top.has(name), name).toBe(false);
  });

  it("the leaked wiring has no runtime export left: schemas, matchers, directory, the Turn seam", () => {
    for (const name of ["AgentSettingsSchema", "AgentsConfigSchema", "CompactionSettingsSchema"])
      expect(root, name).not.toHaveProperty(name);
    expect(root).not.toHaveProperty("TurnStoreRecordRepository");
    expect(mcp).not.toHaveProperty("McpServerConfigSchema");
    for (const name of ["MaxTokensSchema", "PriceSchema", "ModelProviderDirectory"])
      expect(models, name).not.toHaveProperty(name);
    expect(internal).toHaveProperty("ModelProviderDirectory");
    for (const name of ["workflowMatchers", "childMatchers", "compensationMatchers"])
      expect(testing, name).not.toHaveProperty(name);
    expect(testing).not.toHaveProperty("toolCallMatchers");
  });

  it("the names exported type-only add no runtime value: Wrapper, ToolArguments, ConcurrencyMode", () => {
    expect(dto).not.toHaveProperty("Wrapper");
    expect(dto).not.toHaveProperty("ToolArguments");
    expect(testing).not.toHaveProperty("ConcurrencyMode");
  });
});

describe("#895: the leaked wiring and the inlined pieces are named by no public entry", () => {
  const gone: Readonly<Record<string, string>> = {
    agboss: `SqlitePauseStore SqlitePauseQueryRepository SqlitePausedRunRepository SqlitePausedRunRows
      SqlitePauseRows SqlitePauseNoticeRows SqlitePauseScans StoredMailbox PlannedNotice ModelGateway
      ChatModelSpec ChatModelUser DecideSpec DecisionSpec DecisionModel DecisionOutcome
      ReplyInterpreterInput TurnStore ConfigStore MemoryStore PauseAnswerEntry AnswerArgs TurnRecords
      TurnStoreRecordRepository AgentMeta RagBinding AgentToolClass QuestionRoleClass GuardrailFields
      PiiPolicyFields CompactionFields ToolInterceptorFields ChannelMeta ChannelRoleForm AutoDecision
      ComponentClass StartClass ActionClass ContextFields`,
    "agboss-models": `ModelProviderDirectory KeptModelProviderOptions RegisteredModelProvider ProviderQuery
      ProviderResolution ModelProviderBaseOptions ProviderFetch ModelProviderClass WireFields
      MaxTokensSchema PriceSchema`,
    "agboss-testing":
      "MatcherContext Verdict ModelTarget RecordedInput workflowMatchers toolCallMatchers",
    "agboss-mcp": "ServerToolCallable ToolInvocationContext McpServerConfigSchema",
    "agboss-dto": "ListLimits OneOfValues",
    "agboss-eval": "ToolHandlerClass",
  };

  it.each(Object.entries(gone))("%s", (entry, names) => {
    const { top } = namesOf(reportOf(entry));
    for (const name of words(names)) expect(top.has(name), name).toBe(false);
  });

  it("the root, ./testing and ./eval name LangChain's BaseChatModel no more (./models does: a provider returns one)", () => {
    for (const name of ["agboss", "agboss-testing", "agboss-eval"])
      expect(reportOf(name), name).not.toContain("BaseChatModel");
  });

  it("the two gateway options are gone from the public option types", () => {
    for (const name of ["agboss", "agboss-testing"])
      expect(reportOf(name), name).not.toMatch(/readonly gateway\??:/);
  });
});

describe("#895: the type machinery is one @beta namespace per entry", () => {
  const spaces: readonly (readonly [string, string, string, string])[] = [
    [
      "agboss",
      "FlowTypes",
      "Same Member Members Without IsIn NotGiven Resolved LastValue KindOf NameOf",
      "index.ts",
    ],
    [
      "agboss-testing",
      "TestingTypes",
      "AgentTurnFor RouterTurnFor AnswerFor RouteFor IsKnown",
      "testing/index.ts",
    ],
    [
      "agboss-dto",
      "DtoTypes",
      "ListOfFactory OneOfVariants OptionalInnerShape Wrapper",
      "dto/index.ts",
    ],
    ["agboss-eval", "EvalTypes", "EvalContextsOf EvalTurnsOf", "eval/index.ts"],
  ];

  it.each(spaces)(
    "%s: %s holds the machinery, the entry's own names do not",
    (report, space, some, file) => {
      const { top, spaces: inside } = namesOf(reportOf(report));
      expect(top.has(space)).toBe(false); // a namespace, not an `export` line of the report
      const members = inside.get(space) ?? [];
      for (const name of words(some)) {
        expect(members, name).toContain(name);
        expect(top.has(name), name).toBe(false);
      }
      expect(members.length).toBeGreaterThan(1);
      expect(betaOf(join(SRC, file)), file).toContain(space);
    },
  );
});

/** The namespaces an entry file re-exports with a `@beta` tag on the export. */
function betaOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const tagged: string[] = [];
  for (const node of source.statements) {
    if (
      !ts.isExportDeclaration(node) ||
      !node.exportClause ||
      !ts.isNamespaceExport(node.exportClause)
    )
      continue;
    const beta = ts.getJSDocTags(node).some((tag) => tag.tagName.text === "beta");
    if (beta) tagged.push(node.exportClause.name.text);
  }
  return tagged;
}
