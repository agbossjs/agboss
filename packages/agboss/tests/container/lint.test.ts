import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const RULE = "agboss/no-component-state";

/** The rule's findings for `code` as a framework source file, linted with the repo's own config. */
async function findings(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, {
    filePath: `${root}packages/agboss/src/components/container/container.ts`,
  });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

const tool = (body: string, constructorBody = ""): string => `
import { Tool } from "../decorators.js";
class Query {}
@Tool({ name: "jobs", description: "d", input: Query, output: Query })
export class Jobs {
  private seen: string[] = [];
  private calls = 0;
  constructor() {
${constructorBody}
  }
  async run(input: Query): Promise<Query> {
${body}
    return Promise.resolve(input);
  }
}
`;

const service = (member: string): string => `
import { Injectable } from "../decorators.js";
@Injectable()
export class JobCacheService {
  private cache: string[] = [];
${member}
}
`;

describe("#261 AC2: `this.x = …` outside the constructor of a component is a lint error", () => {
  it("flags `this.x = …` and `this.x++` in a method of a @Tool", async () => {
    const found = await findings(tool("    this.seen = [];\n    this.calls++;"));

    expect(found).toHaveLength(2);
    expect(found[0]).toContain("`this.seen = …` outside the constructor of a @Tool");
    expect(found[1]).toContain("`this.calls = …`");
  }, 60_000);

  it("flags any component, any method: an onInit, an arrow-function member, a callback inside a method", async () => {
    const onInit = await findings(service("  onInit(): void {\n    this.cache = ['a'];\n  }"));
    const arrow = await findings(service("  warm = (): void => {\n    this.cache = [];\n  };"));
    const callback = await findings(
      service("  warm(): void {\n    [1].forEach(() => {\n      this.cache = [];\n    });\n  }"),
    );

    expect([onInit, arrow, callback].map((found) => found.length)).toEqual([1, 1, 1]);
    expect(onInit[0]).toContain("outside the constructor of a @Injectable");
  }, 60_000);

  it("allows it in the constructor, in locals, in a function with its own `this` and outside components", async () => {
    const inConstructor = await findings(tool("", "    this.calls = 1;"));
    const local = await findings(tool("    const seen: string[] = [];\n    seen.push('a');"));
    const ownThis = await findings(
      tool("    const reset = function (this: { n: number }) { this.n = 0; };\n    void reset;"),
    );
    const plain = await findings(
      "export class Counter {\n  n = 0;\n  add(): void {\n    this.n += 1;\n  }\n}\n",
    );

    expect([inConstructor, local, ownThis, plain]).toEqual([[], [], [], []]);
  }, 60_000);
});
