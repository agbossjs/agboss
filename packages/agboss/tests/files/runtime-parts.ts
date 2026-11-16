/** The parts of a `FileRuntime` a test of something else does not use: no redactor, no thread. */
export const NO_REDACTION = {
  supportsRedaction: (): boolean => false,
  redact: (): Promise<never> => Promise.reject(new Error("no redactor in this test")),
  redactorKey: (): string => "none",
  threadOwners: (): Promise<readonly string[]> => Promise.resolve([]),
};
