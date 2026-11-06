/**
 * `Symbol.metadata` for decorator metadata (#118). Node has none yet, and without it the `tsc` emit
 * passes `context.metadata = undefined` to every decorator. Imported first by every `@agboss/core`
 * entry, so it is set before any user class is evaluated. esbuild falls back to the same symbol.
 */
if (typeof Reflect.get(Symbol, "metadata") !== "symbol") {
  Object.defineProperty(Symbol, "metadata", { value: Symbol.for("Symbol.metadata") });
}

/** The key decorator metadata lives under on a class. */
export const METADATA_KEY: symbol = Symbol.for("Symbol.metadata");
