import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { FileRefusal, FileUnavailableReason } from "../../files/file-errors.js";
import type { Bytes } from "../../units/index.js";

/** The kinds of `A2AError`: `switch (error.kind)` is exhaustive. */
export enum A2AErrorKind {
  CallerRejected = "caller-rejected",
  Contract = "contract",
  Protocol = "protocol",
  Remote = "remote",
  Unavailable = "unavailable",
  Deadline = "deadline",
  TaskCanceled = "task-canceled",
  TaskFailed = "task-failed",
  TaskInterrupted = "task-interrupted",
  UnexpectedFinish = "unexpected-finish",
  MeshUnsupported = "mesh-unsupported",
  OriginRefused = "origin-refused",
}

/** A call to another agent over A2A failed: the wire, the remote task or the card. */
export type A2AError =
  | A2AError.CallerRejected
  | A2AError.Contract
  | A2AError.Protocol
  | A2AError.Remote
  | A2AError.Unavailable
  | A2AError.Deadline
  | A2AError.TaskCanceled
  | A2AError.TaskFailed
  | A2AError.TaskInterrupted
  | A2AError.UnexpectedFinish
  | A2AError.MeshUnsupported
  | A2AError.OriginRefused;

/** The variants of `A2AError`, each with the facts it carries. */
export declare namespace A2AError {
  /** The caller was rejected. */
  export type CallerRejected = ErrorVariant<A2AErrorKind.CallerRejected, "a2a.caller-rejected">;
  /** The remote's answer breaks its contract. */
  export type Contract = ErrorVariant<A2AErrorKind.Contract, "a2a.contract">;
  /** The remote broke the protocol. */
  export type Protocol = ErrorVariant<A2AErrorKind.Protocol, "a2a.protocol">;
  /** The remote call failed. */
  export type Remote = ErrorVariant<A2AErrorKind.Remote, "a2a.remote">;
  /** The remote cannot be reached. */
  export type Unavailable = ErrorVariant<A2AErrorKind.Unavailable, "a2a.unavailable">;
  /** The call ran past its deadline. */
  export type Deadline = ErrorVariant<A2AErrorKind.Deadline, "a2a.deadline"> & {
    readonly deadlineAt: Date;
  };
  /** The remote task was canceled. */
  export type TaskCanceled = ErrorVariant<A2AErrorKind.TaskCanceled, "a2a.task-canceled">;
  /** The remote task failed. */
  export type TaskFailed = ErrorVariant<A2AErrorKind.TaskFailed, "a2a.task-failed">;
  /** The remote task was interrupted. */
  export type TaskInterrupted = ErrorVariant<A2AErrorKind.TaskInterrupted, "a2a.task-interrupted">;
  /** The remote task finished in a way the call does not take. */
  export type UnexpectedFinish = ErrorVariant<
    A2AErrorKind.UnexpectedFinish,
    "a2a.unexpected-finish"
  >;
  /** The remote does not support the mesh. */
  export type MeshUnsupported = ErrorVariant<A2AErrorKind.MeshUnsupported, "a2a.mesh-unsupported">;
  /** The remote's origin is not allowed. */
  export type OriginRefused = ErrorVariant<A2AErrorKind.OriginRefused, "a2a.origin-refused">;
}

/** `A2AError`: the family's constructor and its variants'. */
export const A2AError: FamilyConstructor<
  A2AError,
  {
    CallerRejected: A2AError.CallerRejected;
    Contract: A2AError.Contract;
    Protocol: A2AError.Protocol;
    Remote: A2AError.Remote;
    Unavailable: A2AError.Unavailable;
    Deadline: A2AError.Deadline;
    TaskCanceled: A2AError.TaskCanceled;
    TaskFailed: A2AError.TaskFailed;
    TaskInterrupted: A2AError.TaskInterrupted;
    UnexpectedFinish: A2AError.UnexpectedFinish;
    MeshUnsupported: A2AError.MeshUnsupported;
    OriginRefused: A2AError.OriginRefused;
  }
> = defineFamily({
  name: "A2AError",
  code: "a2a",
  kinds: A2AErrorKind,
  variants: {
    CallerRejected: ["the caller was rejected"],
    Contract: ["the remote's answer breaks its contract"],
    Protocol: ["the remote broke the protocol"],
    Remote: ["the remote call failed"],
    Unavailable: ["the remote cannot be reached"],
    Deadline: ["the call ran past its deadline"],
    TaskCanceled: ["the remote task was canceled"],
    TaskFailed: ["the remote task failed"],
    TaskInterrupted: ["the remote task was interrupted"],
    UnexpectedFinish: ["the remote task finished in a way the call does not take"],
    MeshUnsupported: ["the remote does not support the mesh"],
    OriginRefused: ["the remote's origin is not allowed"],
  },
});

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
