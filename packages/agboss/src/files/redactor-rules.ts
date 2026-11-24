import { fieldsOf } from "../dto/metadata.js";
import type { DtoClass } from "../dto/types.js";
import type { AgentsConfigOf } from "../config/types.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { resolvedModelUsesOf } from "../models/resolution.js";
import type { AssembledWorkflow } from "../workflow.js";
import { hasModelForm, isTextFormat } from "./file-needs.js";
import { BUILT_IN_REDACTED_TYPES } from "./file-redactor.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { MAX_INLINE_REDACTED } from "./redacted-view.js";
import { isSharpResolvable } from "./sharp-check.js";
import { FileSource, FileView } from "./model-files.js";

/**
 * The start rules of the redacted view (#899 §5, §6, §7): a redactor must take every type the agent's
 * files can be (`[files.no-redactor]`), the built-in needs `sharp`, and a copy too big for the state
 * needs a file store (`[files.redacted-needs-store]`).
 */

/** Whether the application's own redactor takes a media type; one that cannot answer takes none. */
function ownTakes(workflow: AssembledWorkflow, mediaType: string): boolean {
  const own = workflow.ownFileRedactor;
  if (own === undefined) return BUILT_IN_REDACTED_TYPES.includes(mediaType);
  let takes = false;
  try {
    const supports: unknown = Reflect.get(own.prototype as object, "supports");
    // a `supports` that is no function throws here too: taken as taking nothing
    takes =
      Reflect.apply(supports as (type: string) => unknown, own.prototype, [mediaType]) === true;
  } catch {
    // asked on the class, with no instance: a `supports` that needs one takes nothing
  }
  return takes;
}

/** `[files.history-needs-store]`: an earlier turn keeps no bytes, only a descriptor — a file store holds the bytes. */
export function historyViolations(
  name: string,
  files: ResolvedModelFiles,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  if (!files.sources.includes(FileSource.History) || workflow.hasFileStore === true) return [];
  return [
    violation(
      "files.history-needs-store",
      `${name}: FileSource.History needs an A2AFileRepository in @Application({ providers }): a turn keeps its files' descriptors, not their bytes — the inline default has none to read again`,
      [name],
    ),
  ];
}

/** The violations of one agent's redacted view. */
export function redactorViolations(
  name: string,
  files: ResolvedModelFiles,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  if (!files.views.includes(FileView.Redacted)) return [];
  const found: RuleViolation[] = [];
  const untaken = files.allowedMediaTypes.filter(
    (type) => hasModelForm(type) && !isTextFormat(type) && !ownTakes(workflow, type),
  );
  if (untaken.length > 0)
    found.push(
      violation(
        "files.no-redactor",
        `${name}: FileView.Redacted needs a FileRedactor that supports ${untaken.join(", ")} — the built-in redacts png, jpeg and webp; list your own FileRedactor in @Application({ providers }), or take these types in another view`,
        [name],
      ),
    );
  if (workflow.ownFileRedactor === undefined && !isSharpResolvable())
    found.push(
      violation(
        "files.invalid-setting",
        `${name}: files — the built-in image redactor needs the optional peer dependency sharp (npm i sharp), or list your own FileRedactor`,
        [name],
      ),
    );
  if (workflow.hasFileStore !== true && files.maxFileSize > MAX_INLINE_REDACTED)
    found.push(
      violation(
        "files.redacted-needs-store",
        `${name}: FileView.Redacted with maxFileSize over ${String(MAX_INLINE_REDACTED)} bytes needs an A2AFileRepository in @Application({ providers }): a redacted copy over that does not fit in an execution's state`,
        [name],
      ),
    );
  return found;
}

/** Whether a context class has a field marked `sensitive`: the execution then holds values to redact. */
const hasSensitiveField = (type: unknown): boolean =>
  fieldsOf(type as DtoClass).some((field) => field.settings.sensitive !== undefined);

/**
 * `[files.redactor-values-withheld]`: the execution's contexts hold sensitive values, the agent reads a
 * redacted view, and its redactor may not be told them (another provider than the agent's, no
 * `redactionValues: RedactionValues.Always`) — it could not black them out, and the re-encoded image would
 * be passed off as redacted. A start error, never a silent gap.
 */
export function redactorValuesViolations(
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  contexts: Pick<RuntimeContexts, "tenantContext" | "executionContext">,
): RuleViolation[] {
  if (!hasSensitiveField(contexts.tenantContext) && !hasSensitiveField(contexts.executionContext))
    return [];
  const providers = new Map(resolvedModelUsesOf(bundle).map((use) => [use.key, use.provider]));
  return Object.entries(config.agents).flatMap(([name, agent]) => {
    const files = agent.files;
    if (files?.views.includes(FileView.Redacted) !== true || files.redactionSendsValues === true)
      return [];
    const redactor =
      bundle.ownFileRedactor === undefined
        ? `the built-in redactor's model on ${providers.get(`files.redactor.${name}`) ?? "an unknown provider"}`
        : `your own FileRedactor ${bundle.ownFileRedactor.name}`;
    return [
      violation(
        "files.redactor-values-withheld",
        `${name}: its contexts hold sensitive values and it reads FileView.Redacted, but ${redactor} may not be told them — the agent's model is on ${providers.get(`agents.${name}`) ?? "an unknown provider"}; serve both from one provider, or set defaults.files.redactionValues: RedactionValues.Always to send the values wherever the redactor runs (redactionValues is ${files.redactionValues})`,
        [name],
      ),
    ];
  });
}
