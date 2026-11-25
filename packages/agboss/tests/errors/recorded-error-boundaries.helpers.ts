/** What a reader that trusts a `code` property (the run events' `codeOf`) sees of an error. */
export const codeOfErrorRecordBoundary = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";
