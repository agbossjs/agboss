/** How a builder's path begins: a source, or a side path (`.onError`, `.onGroup`, `.onRoute`, …). */
export type PathStart = { readonly kind: "source" } | { readonly kind: "side" };
