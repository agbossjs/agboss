import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { FileRefusal, FileUnavailableReason } from "../../files/file-errors.js";
import type { Bytes } from "../../units/index.js";

// the A2A client's family has its own file (the line limit); it is still `remote-errors`'s to callers
export { A2AError, A2AErrorKind } from "./a2a-errors.js";

/** The kinds of `McpError`: `switch (error.kind)` is exhaustive. */
export enum McpErrorKind {
  Unavailable = "unavailable",
  Contract = "contract",
  MethodNotFound = "method-not-found",
}

/**
 * An MCP server could not be reached or failed the call (`Unavailable`), answered against its
 * contract (`Contract`), or was asked for a tool it does not declare (`MethodNotFound`).
 */
export type McpError = McpError.Unavailable | McpError.Contract | McpError.MethodNotFound;

/** The variants of `McpError`, each with the facts it carries. */
export declare namespace McpError {
  /** The MCP server cannot be reached. */
  export type Unavailable = ErrorVariant<McpErrorKind.Unavailable, "mcp.unavailable">;
  /** The MCP server answered against its contract. */
  export type Contract = ErrorVariant<McpErrorKind.Contract, "mcp.contract">;
  /** The tool called is not declared on the MCP server's class. */
  export type MethodNotFound = ErrorVariant<McpErrorKind.MethodNotFound, "mcp.method-not-found">;
}

/** `McpError`: the family's constructor and its variants'. */
export const McpError: FamilyConstructor<
  McpError,
  {
    Unavailable: McpError.Unavailable;
    Contract: McpError.Contract;
    MethodNotFound: McpError.MethodNotFound;
  }
> = defineFamily({
  name: "McpError",
  code: "mcp",
  kinds: McpErrorKind,
  variants: {
    Unavailable: ["the MCP server cannot be reached"],
    Contract: ["the MCP server answered against its contract"],
    MethodNotFound: ["the tool called is not declared on the MCP server"],
  },
});

/** The kinds of `FileError`: `switch (error.kind)` is exhaustive. */
export enum FileErrorKind {
  Conflict = "conflict",
  Refused = "refused",
  Unavailable = "unavailable",
}

/** A file was refused, is unavailable, or conflicts with the one stored. */
export type FileError = FileError.Conflict | FileError.Refused | FileError.Unavailable;

/** The variants of `FileError`, each with the facts it carries. */
export declare namespace FileError {
  /** A file with this id is stored with other content. */
  export type Conflict = ErrorVariant<FileErrorKind.Conflict, "files.conflict"> & {
    readonly fileId: string;
  };
  /** A file was refused. */
  export type Refused = ErrorVariant<FileErrorKind.Refused, "files.refused"> & {
    readonly refusal: FileRefusal;
    /** The media type it declared, when that is why. */
    readonly mediaType?: string;
    /** Its size, when that is why. */
    readonly sizeBytes?: Bytes;
  };
  /** A file is unavailable. */
  export type Unavailable = ErrorVariant<FileErrorKind.Unavailable, "files.unavailable"> & {
    readonly reason: FileUnavailableReason;
  };
}

/** `FileError`: the family's constructor and its variants'. */
export const FileError: FamilyConstructor<
  FileError,
  { Conflict: FileError.Conflict; Refused: FileError.Refused; Unavailable: FileError.Unavailable }
> = defineFamily({
  name: "FileError",
  code: "files",
  kinds: FileErrorKind,
  variants: {
    Conflict: ["a file with this id is stored with other content"],
    Refused: ["a file was refused"],
    Unavailable: ["a file is unavailable"],
  },
});
