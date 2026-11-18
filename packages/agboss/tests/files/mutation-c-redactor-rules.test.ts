/**
 * #1269: the start rules of the redacted view and of the history — each rule's code, message and node —
 * and the values rule of the execution's contexts.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { nameOf } from "../../src/components/name-of.js";
import { Text } from "../../src/dto/index.js";
import type { ResolvedModelFiles } from "../../src/files/file-settings.js";
import { FileRedactor } from "../../src/files/file-redactor.js";
import { FileView, ModelFiles, RedactionValues } from "../../src/files/model-files.js";
import { redactorValuesViolations } from "../../src/files/redactor-rules.js";
import { MAX_INLINE_REDACTED } from "../../src/files/redacted-view.js";
import {
  ExecutionContext,
  Injectable,
  PiiAction,
  PiiFileAction,
  PiiKind,
  PiiPolicy,
  TenantContext,
  pii,
  type RedactionResult,
} from "../../src/index.js";
import type { RuleViolation } from "../../src/graph/rule-error.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { kilobytes } from "../../src/units/index.js";
import { readerApplication, type ReaderOptions } from "./reader.factory.js";

@PiiPolicy({
  name: "redactor-rules-cards-pii-policy",
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

/** A redactor whose `supports` needs an instance: asked on the class, it takes nothing. */
@Injectable()
class NeedsInstanceRedactor extends FileRedactor {
  private readonly types = ["image/png"];

  supports(mediaType: string): boolean {
    return this.types.includes(mediaType);
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked"));
  }
}

/** A redactor whose `supports` answers something truthy, not `true`. */
@Injectable()
class TruthyRedactor extends FileRedactor {
  supports(): boolean {
    return true;
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked"));
  }
}
Object.defineProperty(TruthyRedactor.prototype, "supports", { value: () => "yes" });

/** A redactor whose `supports` is no function. */
@Injectable()
class NoSupportsRedactor extends FileRedactor {
  supports(): boolean {
    return true;
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked"));
  }
}
Object.defineProperty(NoSupportsRedactor.prototype, "supports", { value: "yes" });

const REDACTED = (types: string[], size = kilobytes(60)) =>
  ModelFiles.of({
    views: [FileView.Redacted],
    allowedMediaTypes: types,
    maxFileSize: size,
    maxTotalFileSize: size,
  });

async function thrownBy(options: ReaderOptions) {
  const app = readerApplication({ piiPolicies: [CardsPolicy], ...options });
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

describe("[files.no-redactor]", () => {
  it("names the types nothing listed can redact, in the order the agent allows them", async () => {
    const { name, found } = await thrownBy({
      files: REDACTED(["application/pdf", "image/png", "audio/mpeg", "text/csv", "image/gif"]),
    });

    expect(found).toEqual([
      {
        code: "files.no-redactor",
        message: `${name}: FileView.Redacted needs a FileRedactor that supports application/pdf, audio/mpeg, image/gif — the built-in redacts png, jpeg and webp; list your own FileRedactor in @Application({ providers }), or take these types in another view`,
        nodes: [name],
      },
    ]);
  });

  it("a redactor that needs an instance to answer, or answers something that is not true, takes nothing", async () => {
    for (const providers of [[NeedsInstanceRedactor], [TruthyRedactor], [NoSupportsRedactor]]) {
      const { name, found } = await thrownBy({ files: REDACTED(["image/png"]), providers });

      expect(found.map((item) => item.code)).toEqual(["files.no-redactor"]);
      expect(found[0]?.message).toContain(
        `${name}: FileView.Redacted needs a FileRedactor that supports image/png`,
      );
    }
  });

  it("a redactor that supports the types takes them", async () => {
    const { found } = await thrownBy({
      files: REDACTED(["image/png", "text/plain"]),
      providers: [PngRedactor],
    });

    expect(found).toEqual([]);
  });
});

describe("[files.redacted-needs-store]", () => {
  it("a copy that may not fit the state of an execution, with no file store", async () => {
    const { name, found } = await thrownBy({
      files: REDACTED(["image/png"], kilobytes(65)),
      providers: [],
    });

    expect(found).toEqual([
      {
        code: "files.redacted-needs-store",
        message: `${name}: FileView.Redacted with maxFileSize over ${String(MAX_INLINE_REDACTED)} bytes needs an A2AFileRepository in @Application({ providers }): a redacted copy over that does not fit in an execution's state`,
        nodes: [name],
      },
    ]);
  });

  it("a file store or a limit that fits leaves none", async () => {
    const stored = await thrownBy({
      files: REDACTED(["image/png"], kilobytes(65)),
      providers: [InMemoryA2AFileRepository],
    });
    const fits = await thrownBy({
      files: REDACTED(["image/png"], kilobytes(64)),
      providers: [],
    });

    expect(stored.found).toEqual([]);
    expect(fits.found).toEqual([]);
  });
});

class PersonContext extends ExecutionContext {
  @Text({ optional: true, sensitive: PiiAction.replaceWithKind() })
  person?: string;
}

class PlainContext extends ExecutionContext {
  @Text({ optional: true })
  note?: string;
}

class PlainTenant extends TenantContext {
  @Text({ optional: true })
  label?: string;
}

class SensitiveTenant extends TenantContext {
  @Text({ optional: true, sensitive: PiiAction.replaceWithKind() })
  owner?: string;
}

async function assembledWith(options: ReaderOptions) {
  const app = readerApplication({
    files: ModelFiles.of({ views: [FileView.Redacted], allowedMediaTypes: ["image/png"] }),
    piiPolicies: [CardsPolicy],
    ...options,
  });
  const [workflow] = (await applicationOf(app.Application)).workflows;
  if (workflow === undefined) throw new Error("no workflow");
  return { workflow, name: nameOf(app.Agent) };
}

describe("[files.redactor-values-withheld]", () => {
  it("the built-in redactor's model: its provider and the agent's named, the setting told", async () => {
    const { workflow, name } = await assembledWith({});

    const found = redactorValuesViolations(workflow, workflow.config, {
      tenantContext: PlainTenant,
      executionContext: PersonContext,
    });

    const message = `${name}: its contexts hold sensitive values and it reads FileView.Redacted, but the built-in redactor's model on openrouter-model-provider may not be told them — the agent's model is on openrouter-model-provider; serve both from one provider, or set defaults.files.redactionValues: RedactionValues.Always to send the values wherever the redactor runs (redactionValues is same-provider)`;
    expect(found).toEqual([{ code: "files.redactor-values-withheld", message, nodes: [name] }]);
  });

  it("a sensitive field of the tenant's context counts as well", async () => {
    const { workflow, name } = await assembledWith({
      defaults: { files: { redactionValues: RedactionValues.Never } },
    });

    const found = redactorValuesViolations(workflow, workflow.config, {
      tenantContext: SensitiveTenant,
      executionContext: PlainContext,
    });

    expect(found.map((item) => item.nodes)).toEqual([[name]]);
    expect(found[0]?.message).toContain("(redactionValues is never)");
  });

  it("the application's own redactor is named by its class", async () => {
    const { workflow } = await assembledWith({ providers: [PngRedactor] });

    const found = redactorValuesViolations(workflow, workflow.config, {
      tenantContext: PlainTenant,
      executionContext: PersonContext,
    });

    expect(found[0]?.message).toContain(
      "but your own FileRedactor PngRedactor may not be told them — the agent's model is on openrouter-model-provider;",
    );
  });

  it("an agent the providers do not know: an unknown provider, twice", async () => {
    const { workflow, name } = await assembledWith({});
    const settings = workflow.config.agents[name];
    if (settings === undefined) throw new Error("no agent");
    const config = { ...workflow.config, agents: { ghost: settings } };

    const found = redactorValuesViolations(workflow, config, {
      tenantContext: PlainTenant,
      executionContext: PersonContext,
    });

    expect(found[0]?.message).toContain(
      "the built-in redactor's model on an unknown provider may not",
    );
    expect(found[0]?.message).toContain("the agent's model is on an unknown provider;");
    expect(found[0]?.nodes).toEqual(["ghost"]);
  });

  it("no sensitive field, an agent with no redacted view, or values it may be told: none", async () => {
    const { workflow, name } = await assembledWith({});
    const settings = workflow.config.agents[name];
    if (settings?.files === undefined) throw new Error("no files");
    const plain = { tenantContext: PlainTenant, executionContext: PlainContext };
    const sensitive = { tenantContext: PlainTenant, executionContext: PersonContext };
    const withFiles = (files: ResolvedModelFiles) => ({
      ...workflow.config,
      agents: { [name]: { ...settings, files } },
    });
    const { files } = settings;

    expect(redactorValuesViolations(workflow, workflow.config, plain)).toEqual([]);
    expect(
      redactorValuesViolations(
        workflow,
        withFiles({ ...files, views: [FileView.Original] }),
        sensitive,
      ),
    ).toEqual([]);
    expect(
      redactorValuesViolations(
        workflow,
        withFiles({ ...files, redactionSendsValues: true }),
        sensitive,
      ),
    ).toEqual([]);
    expect(
      redactorValuesViolations(
        workflow,
        { ...workflow.config, agents: { [name]: { ...settings, files: undefined } } },
        sensitive,
      ),
    ).toEqual([]);
  });
});
