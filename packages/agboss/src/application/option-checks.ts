import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { McpTransport } from "../config/mcp-server-config.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ApplicationOptions } from "./application.js";
import { providersOf } from "./listed-providers.js";

/**
 * What the shelves of the selected profiles name must exist in the application, and what they set must fit
 * (#1318c): a channel, an A2A endpoint or agent, an MCP server (found once the workflows are assembled).
 */

const failure = (reason: ProfileErrorReason, message: string): ProfileError =>
  new ProfileError({ reason, message });

/** The classes the application and its workflows list in `providers` and `services`, each once. */
function listedClassesIn(options: ApplicationOptions): readonly Class[] {
  const listed = [
    ...providersOf(options),
    ...withChildWorkflows(options.workflows).flatMap((workflow) => {
      const declaration = declarationOf(workflow);
      return declaration?.kind === NodeKind.Workflow ? providersOf(declaration.options) : [];
    }),
  ];
  return [
    ...new Set(listed.filter((provider): provider is Class => typeof provider === "function")),
  ];
}

/** The `@Channel` classes the application and its workflows list, each once. */
const channelClassesOf = (options: ApplicationOptions): readonly Class[] =>
  listedClassesIn(options).filter((cls) => componentOf(cls)?.kind === "channel");

/** A shelf name is a channel of the application, and a `ttl` is given only to a channel bound to a pause target. */
export function checkChannels(folded: FoldedConfig, options: ApplicationOptions): void {
  const profiles = folded.profiles.join(",");
  const metas = channelClassesOf(options).flatMap((cls) => {
    const component = componentOf(cls);
    return component?.kind === "channel" ? [component.meta] : [];
  });
  for (const [name, overlay] of Object.entries(folded.channels)) {
    const meta = metas.find((one) => one.name === name);
    if (meta === undefined)
      throw failure(
        ProfileErrorReason.Unknown,
        `profile ${profiles}: channels.${name}: no such @Channel in the application — it has: ${metas.map((one) => one.name).join(", ") || "none"}`,
      );
    if (overlay.ttl !== undefined && meta.target === undefined)
      throw failure(
        ProfileErrorReason.Invalid,
        `profile ${profiles}: channels.${name}.ttl: ${name} is bound to no pause target, so it keeps no closed pause — only a @Channel({ target }) has a ttl`,
      );
  }
}

/** The `@A2AEndpoint` and `@A2AAgent` names the application has: a shelf may name only those. */
export function checkListed(folded: FoldedConfig, options: ApplicationOptions): void {
  const profiles = folded.profiles.join(",");
  const classes = [...listedClassesIn(options), ...(options.endpoints ?? [])];
  const shelves = [
    ["a2aEndpoints", "a2a-endpoint", "@A2AEndpoint", folded.a2aEndpoints],
    ["a2aAgents", "a2a-agent", "@A2AAgent", folded.a2aAgents],
  ] as const;
  for (const [shelf, kind, decorator, entries] of shelves) {
    const has = classes.flatMap((cls) => {
      const component = componentOf(cls);
      return component?.kind === kind ? [component.meta.name] : [];
    });
    const [lost] = Object.keys(entries).filter((name) => !has.includes(name));
    if (lost !== undefined)
      throw failure(
        ProfileErrorReason.Unknown,
        `profile ${profiles}: ${shelf}.${lost}: no such ${decorator} in the application — it has: ${[...new Set(has)].join(", ") || "none"}`,
      );
  }
}

/** An `a2aAgents` address a profile gives is a URL, as a declared one must be (`[a2a.url-invalid]`). */
export function checkAgentUrls(folded: FoldedConfig): void {
  const [bad] = Object.entries(folded.a2aAgents).filter(
    ([, overlay]) => typeof overlay.url === "string" && !URL.canParse(overlay.url),
  );
  if (bad !== undefined)
    throw failure(
      ProfileErrorReason.Invalid,
      `profile ${folded.profiles.join(",")}: a2aAgents.${bad[0]}.url: is no URL`,
    );
}

/** A name in the `mcpServers` shelf is a server some workflow reaches, and what it sets fits its transport. */
export function checkMcpServers(
  folded: FoldedConfig,
  assembled: readonly AssembledWorkflow[],
): void {
  const profiles = folded.profiles.join(",");
  const configs = new Map(
    assembled.flatMap((workflow) => Object.entries(workflow.mcpServerConfigs ?? {})),
  );
  for (const [name, overlay] of Object.entries(folded.mcpServers)) {
    const config = configs.get(name);
    if (config === undefined)
      throw failure(
        ProfileErrorReason.Unknown,
        `profile ${profiles}: mcpServers.${name}: no such @McpServer in use in the application — it has: ${[...configs.keys()].join(", ") || "none"}`,
      );
    const isHttp = config.transport === McpTransport.Http;
    const misfit = (isHttp ? ["command", "args"] : ["url"]).find(
      (key) => Reflect.get(overlay, key) !== undefined,
    );
    if (misfit !== undefined)
      throw failure(
        ProfileErrorReason.Invalid,
        `profile ${profiles}: mcpServers.${name}.${misfit}: ${name} is ${isHttp ? "an HTTP" : "a stdio"} server, it has no ${misfit}`,
      );
  }
}
