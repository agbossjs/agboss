import { TenantContext, type AssembledWorkflow, type Environment } from "@agboss/core";
import { describeServices, standaloneContexts } from "@agboss/core/internal";
import type { IndexReport, RagConnector } from "@agboss/core/rag";
import {
  applicationEnvironment,
  assembleApplication,
  loadCliApplication,
} from "./cli/cli-application.js";
import { textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { didYouMean } from "./cli/did-you-mean.js";
import { checkedTenantOption, usageError } from "./cli/errors.js";

/** One knowledge base of the application: its name and its connector. */
interface KnowledgeBase {
  readonly name: string;
  readonly connector: RagConnector;
}

/** Every knowledge base of every workflow, each once (two workflows may bind one). */
function knowledgeBasesOf(
  workflows: readonly AssembledWorkflow[],
  environment: Environment | undefined,
): readonly KnowledgeBase[] {
  // no router runs here; the connectors read the application's environment through its contexts
  const bases = workflows.flatMap(
    (workflow) =>
      workflow.knowledgeBases?.({
        router: describeServices.router,
        contexts: standaloneContexts(workflow.config, environment),
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

/** The application as `rag index` reads it: its name and the tenant context it declares. */
interface TenantSource {
  readonly name: string;
  readonly tenantContext: typeof TenantContext;
}

/**
 * `--tenant <id>` (#700): whose knowledge bases to build. None → the `default` tenant, only in an
 * application that declares no tenant context, where it is the only one (#797); one that declares
 * a context has others, so `rag.tenant-required`, exit 2, nothing built — as `records export`.
 */
function tenantOf(given: string | undefined, application: TenantSource): string {
  if (given !== undefined) return given;
  if (application.tenantContext === TenantContext) return "default";
  throw usageError(
    "rag",
    "rag.tenant-required",
    `name the tenant whose knowledge bases to build with --tenant <id>: "${application.name}" declares a tenant context (${application.tenantContext.name}), so "default" is nobody's`,
  );
}

const reportLine = (name: string, report: IndexReport): string =>
  `${name}: ${String(report.documents)} documents, ${String(report.chunks)} chunks, ${String(report.skipped)} unchanged · $${(report.costUsd ?? 0).toFixed(6)}`;

/**
 * `agboss rag index [--rag <name>] [--tenant <id>]` — builds or updates every knowledge base of the
 * application for one tenant (#700: each connector indexes into that tenant only; #797: `--tenant`
 * required when the application declares a tenant context).
 */
export const handle: CommandHandler = async (context) => {
  if (context.positionals[0] !== "index" || context.positionals.length > 1)
    throw usageError("rag", "usage.missing-argument", 'expected "agboss rag index …"');
  const given = checkedTenantOption("rag", textOption(context.values, "tenant"));
  const loaded = await loadCliApplication(context);
  const assembled = await assembleApplication(context, loaded);
  const tenantId = tenantOf(given, assembled);
  const environment = await applicationEnvironment(context, assembled);
  const bases = selected(context, knowledgeBasesOf(assembled.workflows, environment));
  if (bases.length === 0) context.say(`No knowledge bases in "${assembled.name}".`);
  const indexed = [];
  for (const { name, connector } of bases) {
    if (connector.index === undefined) {
      context.say(`${name}: no index to build (the connector has none)`);
      continue;
    }
    const report = await connector.index({ tenantId, signal: new AbortController().signal });
    indexed.push({ name, tenantId, ...report });
    context.say(reportLine(name, report));
  }
  return { result: { tenantId, indexed } };
};
