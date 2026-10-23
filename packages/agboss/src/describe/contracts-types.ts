import type { JsonSchema } from "../dto/schema.js";

/** The shapes of `describe --json`'s `application.contracts` (#398 PR 3; `contracts.ts`). */

/** A DTO as a contract names it. */
export interface ContractDto {
  readonly dto: string;
  readonly schemaHash: string;
}

/** An `@A2AExpose` start. */
export interface A2AExportContract {
  readonly kind: "a2a";
  readonly expose: string;
  readonly version: string;
  readonly start: string;
  readonly workflow: string;
  /** The start's input; `null` when it is a map of fields, not one DTO. */
  readonly input: ContractDto | null;
  readonly outputs: readonly (ContractDto & { readonly finish: string })[];
}

/** An `@McpExpose` tool: an exported start or tool. */
export interface McpExportContract {
  readonly kind: "mcp";
  readonly expose: string;
  readonly version: string;
  readonly tool: string;
  readonly input: ContractDto | null;
}

/** Where a tool of the application uses a consumed contract. */
export interface ContractUse {
  readonly workflow: string;
  readonly tool: string;
}

/** An `@A2AAgent`: what it calls, sends and gets back. */
export interface A2AImportContract {
  readonly kind: "a2a";
  readonly client: string;
  readonly target: { readonly application: string; readonly start: string };
  readonly usedBy: readonly ContractUse[];
  readonly input: ContractDto;
  readonly output: ContractDto;
  /** The contract price of one call, in USD; `null` without one. */
  readonly price: number | null;
}

/** An `@McpServer` tool the application calls. */
export interface McpImportContract {
  readonly kind: "mcp";
  readonly server: string;
  readonly tool: string;
  /** The AGBoss application behind the server; `null` for a third-party one (no federation). */
  readonly target: { readonly application: string; readonly expose: string } | null;
  /** The tools of the application's agents that call it (#398 PR 4). */
  readonly usedBy: readonly ContractUse[];
  readonly input: ContractDto;
  readonly output: ContractDto;
}

/** `application.contracts` of `describe --json`. */
export interface ContractsSnapshot {
  readonly exports: readonly (A2AExportContract | McpExportContract)[];
  readonly imports: readonly (A2AImportContract | McpImportContract)[];
  readonly schemas: Readonly<
    Record<string, { readonly schemaHash: string; readonly jsonSchema: JsonSchema }>
  >;
}
