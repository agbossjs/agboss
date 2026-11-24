import type { ModelProviderResponse } from "./transport.js";

/**
 * A streamed call's text as an async sequence (#1311b): `read` pushes the text into `onText` as it
 * comes and ends with the call's answer; the sequence yields each text as it is pushed, then yields
 * the answer last (the one value that is no text), or throws the call's failure after the text that came before it. A consumer that
 * stops early aborts the call (`stop`): the provider is not left streaming to nobody.
 */
export async function* chunksOf(
  read: (onText: (text: string) => Promise<void>) => Promise<ModelProviderResponse>,
  stop: () => void,
): AsyncGenerator<string | ModelProviderResponse> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const end: {
    outcome?: { readonly answer: ModelProviderResponse } | { readonly error: unknown };
  } = {};
  const signal = (): void => {
    wake?.();
    wake = undefined;
  };
  void read((text) => {
    queue.push(text);
    signal();
    return Promise.resolve();
  }).then(
    (answer) => {
      end.outcome = { answer };
      signal();
    },
    (error: unknown) => {
      end.outcome = { error };
      signal();
    },
  );
  try {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      const done = end.outcome;
      if (done !== undefined) {
        if ("error" in done) throw done.error;
        yield done.answer;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (end.outcome === undefined) stop();
  }
}
