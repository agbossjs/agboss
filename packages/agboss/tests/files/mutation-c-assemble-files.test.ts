import { ComponentKind } from "../../src/flow/runtime/records.js";
import { hours, Ttl } from "../../src/units/index.js";
/**
 * #1269: the files of a workflow's agents resolved from their sources (#899 §1) — the application's own
 * transcriber, redactor and file store among its providers, each agent's levels, the media types
 * narrowed to what the models take.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { nameOf } from "../../src/components/name-of.js";
import { InjectionToken, provide, type Class } from "../../src/components/injection.js";
import type { AgentMeta } from "../../src/components/meta-types.js";
import type { AgentsConfigOf } from "../../src/config/types.js";
import {
  agentFilesOf,
  hasFileStore,
  ownFileRedactorOf,
  ownFileTranscriberOf,
  withAgentFiles,
  withNarrowedFiles,
  type FilesSources,
} from "../../src/files/assemble-files.js";
import { FilePolicy } from "../../src/files/file-policy.js";
import { FileRedactor, ModelImageRedactor } from "../../src/files/file-redactor.js";
import { FileTranscriber, ModelFileTranscriber } from "../../src/files/file-transcriber.js";
import { AnswerFiles, FileView, ModelFiles } from "../../src/files/model-files.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { InlineFileRepository } from "../../src/infrastructure/file.repository.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import type { ModelUse } from "../../src/models/uses.js";
import { kilobytes } from "../../src/units/index.js";
import { Agent, Workflow, WorkflowFinish, WorkflowStart, inline } from "../../src/index.js";
import { WorkflowFinishTextDto } from "../../src/dto/index.js";
import type { WorkflowDefaults } from "../../src/flow/decorators/workflow.js";
import { onStart } from "../helpers/flow.js";
import { BundleDto, readerApplication } from "./reader.factory.js";
import { ComponentOptions } from "../../src/components/component-options.js";

class OwnTranscriber extends FileTranscriber {
  transcribe(): Promise<never> {
    return Promise.reject(new Error("not asked"));
  }
}
class OwnRedactor extends FileRedactor {
  supports(): boolean {
    return false;
  }

  redact(): Promise<never> {
    return Promise.reject(new Error("not asked"));
  }
}
class OwnStore extends InMemoryFileRepository {}
class OwnInline extends InlineFileRepository {}
class Plain {
  readonly kind = "plain";
}

const TOKEN = new InjectionToken<number>("a-number");
/** A value provider that carries a `prototype` as a class does: no class, whatever it carries. */
const lookalike = (cls: Class) => Object.assign(provide(TOKEN, 1), { prototype: cls.prototype });

describe("the application's own providers", () => {
  it("its own FileTranscriber: the listed subclass, never the built-in nor a look-alike", () => {
    expect(ownFileTranscriberOf([Plain, OwnTranscriber])).toBe(OwnTranscriber);
    expect(ownFileTranscriberOf([ModelFileTranscriber])).toBeUndefined();
    expect(ownFileTranscriberOf([Plain, OwnRedactor])).toBeUndefined();
    expect(ownFileTranscriberOf([lookalike(OwnTranscriber)])).toBeUndefined();
    expect(ownFileTranscriberOf([])).toBeUndefined();
    expect(ownFileTranscriberOf(undefined)).toBeUndefined();
  });

  it("its own FileRedactor: the listed subclass, never the built-in nor a look-alike", () => {
    expect(ownFileRedactorOf([Plain, OwnRedactor])).toBe(OwnRedactor);
    expect(ownFileRedactorOf([ModelImageRedactor])).toBeUndefined();
    expect(ownFileRedactorOf([Plain, OwnTranscriber])).toBeUndefined();
    expect(ownFileRedactorOf([lookalike(OwnRedactor)])).toBeUndefined();
    expect(ownFileRedactorOf([])).toBeUndefined();
    expect(ownFileRedactorOf(undefined)).toBeUndefined();
  });

  it("a file store: a FileRepository that is not the inline default nor one of its kind", () => {
    expect(hasFileStore([OwnStore])).toBe(true);
    expect(hasFileStore([Plain, InMemoryFileRepository])).toBe(true);
    expect(hasFileStore([InlineFileRepository])).toBe(false);
    expect(hasFileStore([OwnInline])).toBe(false);
    expect(hasFileStore([Plain, OwnTranscriber])).toBe(false);
    expect(hasFileStore([lookalike(OwnStore)])).toBe(false);
    expect(hasFileStore([])).toBe(false);
    expect(hasFileStore(undefined)).toBe(false);
  });
});

let counter = 0;

/** A workflow of one agent with the files and the defaults a test gives; its start and its agent. */
function miniWorkflow(files?: ModelFiles, defaults?: WorkflowDefaults, filePolicy?: Class) {
  counter += 1;
  const suffix = String(counter);

  @Agent({
    name: `mini-${suffix}-agent`,
    description: "Reads",
    prompt: inline("Read."),
    model: "local/reader",
    input: { bundle: BundleDto },
    ...(files === undefined ? {} : { files }),
  })
  class MiniAgent {}

  @WorkflowStart({ name: `mini-${suffix}-start`, description: "A bundle", input: BundleDto })
  class MiniStart {}

  @WorkflowFinish({
    name: `mini-${suffix}-finish`,
    description: "Done",
    output: WorkflowFinishTextDto,
  })
  class MiniFinish {}

  @Workflow({
    name: `mini-${suffix}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(MiniStart).toAgent(MiniAgent).toFinish(MiniFinish)],
    ...(defaults === undefined ? {} : { defaults }),
    ...(filePolicy === undefined ? {} : { filePolicy }),
  })
  class MiniWorkflow {}

  return { Workflow: MiniWorkflow, Start: MiniStart, Agent: MiniAgent };
}

const agentMetaOf = (agent: Class): AgentMeta => {
  const declaration = declarationOf(agent);
  if (declaration?.kind !== ComponentKind.Agent) throw new Error("not an agent");
  return declaration.options;
};

class SomePolicy {
  readonly kind = "a policy";
}

const sourcesOf = (
  mini: ReturnType<typeof miniWorkflow>,
  over: Partial<FilesSources> = {},
): FilesSources => ({
  owner: undefined,
  workflow: mini.Workflow,
  agents: [agentMetaOf(mini.Agent)],
  pii: { byElement: new Map() },
  options: ComponentOptions.none,
  ...over,
});

describe("an agent's files of its sources", () => {
  it("none for an agent that did not opt in", () => {
    const mini = miniWorkflow();

    expect(agentFilesOf(agentMetaOf(mini.Agent), sourcesOf(mini))).toBeUndefined();
  });

  it("with no owner and no defaults declared: the built-ins", () => {
    const mini = miniWorkflow(ModelFiles.of({}));

    const files = agentFilesOf(agentMetaOf(mini.Agent), sourcesOf(mini));

    expect(files?.maxFiles).toBe(5);
    expect(files?.views).toEqual([FileView.Original]);
    expect(files?.answerFiles).toBe(AnswerFiles.SeenInVisit);
  });

  it("the workflow's declared defaults over the owner's, the agent's own over both", () => {
    const mini = miniWorkflow(ModelFiles.of({ maxFileSize: kilobytes(2) }), {
      files: { maxFiles: 3 },
    });
    const owner = {
      defaults: { files: { maxFiles: 9, transcriptionMaxTokens: 11, maxFileSize: kilobytes(8) } },
    };

    const files = agentFilesOf(agentMetaOf(mini.Agent), sourcesOf(mini, { owner }));

    expect(files?.maxFiles).toBe(3);
    expect(files?.transcriptionMaxTokens).toBe(11);
    expect(files?.maxFileSize).toBe(kilobytes(2));
  });

  it("the workflow's filePolicy gives the size and the types", () => {
    @FilePolicy({ ttl: hours(24), maxFileSize: kilobytes(7), allowedMediaTypes: ["text/plain"] })
    class SmallTextPolicy {}
    const mini = miniWorkflow(ModelFiles.of({}), undefined, SmallTextPolicy);

    const files = agentFilesOf(agentMetaOf(mini.Agent), sourcesOf(mini));

    expect(files?.maxFileSize).toBe(kilobytes(7));
    expect(files?.allowedMediaTypes).toEqual(["text/plain"]);
  });

  it("a PII policy of the agent makes the transcription its default view", () => {
    const mini = miniWorkflow(ModelFiles.of({}));
    const meta = agentMetaOf(mini.Agent);

    const withPolicy = agentFilesOf(
      meta,
      sourcesOf(mini, { pii: { byElement: new Map([[meta.name, [SomePolicy]]]) } }),
    );
    const noneForIt = agentFilesOf(
      meta,
      sourcesOf(mini, {
        pii: {
          byElement: new Map([
            [meta.name, []],
            ["other-agent", [SomePolicy]],
          ]),
        },
      }),
    );

    expect(withPolicy?.views).toEqual([FileView.Transcription]);
    expect(noneForIt?.views).toEqual([FileView.Original]);
  });
});

/** The config a reader application assembles to, and its one agent. */
async function assembledConfig(files: ModelFiles) {
  const app = readerApplication({ files });
  const [assembled] = (await applicationOf(app.Application)).workflows;
  if (assembled === undefined) throw new Error("no workflow");
  const [name] = Object.keys(assembled.config.agents);
  if (name === undefined) throw new Error("no agent");
  return { config: assembled.config, name, agent: app.Agent };
}

const kindsOf = (...kinds: ("text" | "image" | "file" | "audio" | "video")[]) => kinds;

describe("the config with each agent's defaulted types narrowed to the kinds its models take", () => {
  it("the types of the kinds the agent's model takes stay", async () => {
    const { config, name } = await assembledConfig(ModelFiles.of({}));

    const narrowed = withNarrowedFiles(
      config,
      new Map([[`agents.${name}`, kindsOf("image", "text")]]),
      [],
    );

    expect(narrowed.agents[name]?.files?.allowedMediaTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]);
  });

  it("what every model that reads the files takes: its guardrails' and judges' too, no other's", async () => {
    const { config, name } = await assembledConfig(ModelFiles.of({}));
    const inputs = new Map([
      [`agents.${name}`, kindsOf("image", "text", "file")],
      ["guardrails.reads-a", kindsOf("text", "file")],
      ["guardrails.reads-b", kindsOf("text", "image")],
      ["guardrails.other-agent", kindsOf()],
      ["guardrails.nobody", kindsOf()],
    ]);
    const uses = [
      { key: "guardrails.reads-a", forAgents: [name] },
      { key: "guardrails.reads-b", forAgents: ["x", name] },
      { key: "guardrails.other-agent", forAgents: ["x"] },
      { key: "guardrails.nobody" },
      { key: "guardrails.unknown-model", forAgents: [name] },
    ] as Pick<ModelUse, "key" | "forAgents">[];

    const narrowed = withNarrowedFiles(config, inputs, uses);

    expect(narrowed.agents[name]?.files?.allowedMediaTypes).toEqual([
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]);
  });

  it("an agent no model of which reports its kinds, or which named its types, is left as it is", async () => {
    const defaulted = await assembledConfig(ModelFiles.of({}));
    const named = await assembledConfig(ModelFiles.of({ allowedMediaTypes: ["application/pdf"] }));

    expect(withNarrowedFiles(defaulted.config, new Map(), []).agents).toEqual(
      defaulted.config.agents,
    );
    expect(
      withNarrowedFiles(named.config, new Map([[`agents.${named.name}`, kindsOf("text")]]), [])
        .agents[named.name]?.files?.allowedMediaTypes,
    ).toEqual(["application/pdf"]);
  });

  it("an agent with no files is left as it is", async () => {
    const { config, name } = await assembledConfig(ModelFiles.of({}));
    const { files: _dropped, ...bare } = config.agents[name] ?? {};
    const without = { ...config, agents: { [name]: bare } } as AgentsConfigOf<string>;

    const narrowed = withNarrowedFiles(without, new Map([[`agents.${name}`, kindsOf("text")]]), []);

    expect(narrowed.agents[name]).toBe(without.agents[name]);
  });
});

describe("the config with each opted-in agent's resolved files", () => {
  it("an agent that opted in gets its files, the others' settings stay", async () => {
    const mini = miniWorkflow(ModelFiles.of({ maxFiles: 2 }));
    const closed = miniWorkflow();
    const { config, name } = await assembledConfig(ModelFiles.of({}));
    const { files: _dropped, ...bare } = config.agents[name] ?? {};
    const stripped = {
      ...config,
      agents: { [agentMetaOf(mini.Agent).name]: bare, [agentMetaOf(closed.Agent).name]: bare },
    } as AgentsConfigOf<string>;
    const sources = sourcesOf(mini, {
      agents: [agentMetaOf(mini.Agent), agentMetaOf(closed.Agent)],
    });

    const resolved = withAgentFiles(stripped, sources);

    expect(resolved.agents[agentMetaOf(mini.Agent).name]?.files?.maxFiles).toBe(2);
    expect(resolved.agents[agentMetaOf(closed.Agent).name]).toBe(
      stripped.agents[agentMetaOf(closed.Agent).name],
    );
    expect(Object.keys(resolved.agents)).toHaveLength(2);
  });

  it("no agent opted in: the config as it is", async () => {
    const mini = miniWorkflow();
    const { config } = await assembledConfig(ModelFiles.of({}));

    expect(withAgentFiles(config, sourcesOf(mini))).toBe(config);
  });
});
