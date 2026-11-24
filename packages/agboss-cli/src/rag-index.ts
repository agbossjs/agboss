import type { Environment } from "@agboss/core";
import type { AssembledWorkflow } from "@agboss/core/internal";
import { describeServices, contextsOutsideExecution } from "@agboss/core/internal";
import { RagScope, type RagIndexReport } from "@agboss/core/rag";
import {
  applicationEnvironment,
  assembleApplication,
  loadCliApplication,
} from "./cli/cli-application.js";
import { textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { didYouMean } from "./cli/did-you-mean.js";
import { CliError, scopeOptionOf, tenantOptionOf, usageError } from "./cli/errors.js";
import { stopSignal } from "./cli/stop-signal.js";

/** One knowledge base of the application: its name, its scope and its index (none: `undefined`). */
interface KnowledgeBase {
  readonly name: string;
  readonly scope: RagScope;
  readonly index: (options: {
    readonly tenantId?: string;
    readonly scopeId?: string;
    readonly scope?: RagScope;
    readonly signal: AbortSignal;
  }) => Promise<RagIndexReport | undefined>;
}

/** Every knowledge base of every workflow, each once (two workflows may bind one). */
function knowledgeBasesOf(
  workflows: readonly AssembledWorkflow[],
  environment: Environment | undefined,
): readonly KnowledgeBase[] {
  // no router runs here; the sources read the application's environment through its contexts
  const bases = workflows.flatMap(
    (workflow) =>
      workflow.knowledgeBases?.({
        router: describeServices.router,
        contexts: contextsOutsideExecution(workflow.config, environment),
      }) ?? [],
  );
  return [...new Map(bases.map((base) => [base.name, base])).values()];
}

/** `--rag <name>`: that knowledge base exactly; an unknown name lists the known ones. */
function selected(
  context: CommandContext,
  bases: readonly KnowledgeBase[],
): readonly KnowledgeBase[] {
  const name = textOption(context.values, "rag");
  if (name === undefined) return bases;
  const found = bases.filter((base) => base.name === name);
  if (found.length > 0) return found;
  const names = bases.map((base) => base.name);
  throw usageError(
    "rag",
    "rag.not-found",
    `Knowledge base "${name}" not found.${didYouMean(name, names)} The knowledge bases: ${names.join(", ") || "none"}`,
  );
}

/** The scope a base indexes: its tenant, and its id within the tenant (a tenant's own: the tenant). */
interface IndexScope {
  readonly tenantId?: string;
  readonly scopeId?: string;
}

/**
 * `--tenant <id>` and `--scope <id>`: whose passages to build. A scope other than `Shared` is bound
 * to a tenant — an owner id or a custom key is unique within one — so `--tenant` is required for it
 * (a `Tenant` base is that tenant's own: no `--scope`); an owner or custom base needs `--scope` too.
 * A shared one is built with neither: a multi-tenant application never names a tenant for it.
 */
function scopeOf(
  base: KnowledgeBase,
  given: { readonly tenant: string | undefined; readonly scope: string | undefined },
): IndexScope {
  if (base.scope === RagScope.Shared) return {};
  const { tenant, scope } = given;
  if (tenant === undefined)
    throw usageError(
      "rag",
      "rag.tenant-required",
      `name the tenant to build for "${base.name}" with --tenant <id>: its scope is ${base.scope}, and every non-shared scope belongs to one tenant`,
    );
  if (base.scope === RagScope.Tenant) return { tenantId: tenant, scopeId: tenant };
  if (scope === undefined)
    throw usageError(
      "rag",
      "rag.scope-required",
      `name the scope to build for "${base.name}" with --scope <id>: its scope is ${base.scope}, so it indexes one ${base.scope === RagScope.Owner ? "owner" : "scope"} of the tenant at a time`,
    );
  return { tenantId: tenant, scopeId: scope };
}

const reportLine = (name: string, report: RagIndexReport): string =>
  `${name}: ${String(report.documents)} documents, ${String(report.chunks)} chunks, ${String(report.skipped)} unchanged · $${(report.costUsd ?? 0).toFixed(6)}${report.tokens === undefined ? "" : ` · ${String(report.tokens)} tokens`}`;

/** Ctrl+C (or SIGTERM) during an index: the source stopped where it was, its index as it found it. */
const interrupted = (name: string): CliError =>
  new CliError(
    "internal",
    "rag.interrupted",
    `interrupted while indexing ${name}: its index is left as it was before this run (the knowledge bases before it are built)`,
  );

/** Each knowledge base indexed in turn for its scope, under `signal` (Ctrl+C aborts it, #891). */
async function indexAll(
  context: CommandContext,
  bases: readonly KnowledgeBase[],
  given: { readonly tenant: string | undefined; readonly scope: string | undefined },
  signal: AbortSignal,
): Promise<readonly ({ readonly name: string } & IndexScope & RagIndexReport)[]> {
  // every base's scope is checked before any is built: a refusal builds nothing
  const planned = bases.map((base) => ({ base, scope: scopeOf(base, given) }));
  const indexed = [];
  for (const { base, scope } of planned) {
    const { name } = base;
    if (signal.aborted) throw interrupted(name);
    const options = { ...scope, scope: base.scope, signal };
    const report = await base.index(options).catch((error: unknown) => {
      throw signal.aborted ? interrupted(name) : error;
    });
    if (report === undefined) {
      context.say(`${name}: no index to build (the source has none)`);
      continue;
    }
    indexed.push({ name, ...scope, ...report });
    context.say(reportLine(name, report));
  }
  return indexed;
}

/**
 * `agboss rag index [--rag <name>] [--tenant <id>] [--scope <id>]` — builds or updates every knowledge base of the
 * application for one scope (each source indexes into that scope only). `--scope` is required only
 * for a knowledge base whose `@Rag` declares a scope other than `Shared`; a shared one is built once
 * with no scope. Ctrl+C aborts the source's signal (#891): exit 1, `rag.interrupted` — a source
 * keeps its index whole or as it was (`SqliteFtsRagSource` writes a scope's index in one transaction).
 */
export const handle: CommandHandler = async (context) => {
  if (context.positionals[0] !== "index" || context.positionals.length > 1)
    throw usageError("rag", "usage.missing-argument", 'expected "agboss rag index …"');
  const given = {
    tenant: tenantOptionOf("rag", textOption(context.values, "tenant")),
    scope: scopeOptionOf("rag", textOption(context.values, "scope")),
  };
  const loaded = await loadCliApplication(context);
  const assembled = await assembleApplication(context, loaded);
  const environment = await applicationEnvironment(context, assembled);
  const bases = selected(context, knowledgeBasesOf(assembled.workflows, environment));
  if (bases.length === 0) context.say(`No knowledge bases in "${assembled.name}".`);
  const stop = stopSignal();
  try {
    return {
      result: {
        ...(given.tenant === undefined ? {} : { tenantId: given.tenant }),
        ...(given.scope === undefined ? {} : { scopeId: given.scope }),
        indexed: await indexAll(context, bases, given, stop.signal),
      },
    };
  } finally {
    stop.release();
  }
};
