/** Aborts on Ctrl+C or SIGTERM; `release` removes the listeners (`agboss dev`, `agboss eval ui`). */
export function stopSignal(): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    signal: controller.signal,
    release: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}
