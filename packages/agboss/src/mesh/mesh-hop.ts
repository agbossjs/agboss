/**
 * The mesh (#398): AGBoss applications calling each other over A2A (`A2AClient` → `a2aHttpListener`)
 * and MCP (an `@McpServer` → `createMcpService`). Each request carries the chain of applications it
 * passed through, so a call that comes back to where it started is refused before it runs.
 */

/**
 * Where a request enters an application: the application's `@Application({ name })` and the
 * workflow start it runs — or, over MCP, the exported tool it calls.
 */
export interface MeshEntry {
  /** The application (`billing-application`). */
  readonly application: string;
  /** The workflow start's `name` (`billing-workflow-start`), or an exported MCP tool's. */
  readonly start: string;
}

/** One application a request passed through: its entry and the root execution that called on. */
export interface MeshHop extends MeshEntry {
  /** The root execution of the calling application's tree. */
  readonly executionId: string;
}

/** The chain as one line: `orders-application › orders-workflow-start → billing-application › …`. */
export const chainText = (chain: readonly MeshEntry[]): string =>
  chain.map((hop) => `${hop.application} › ${hop.start}`).join(" → ");
