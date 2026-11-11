/** What an observer hook may return (#261): it is awaited, its value is ignored. */
export type HookResult = Promise<void> | void;
