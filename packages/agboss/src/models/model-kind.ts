/**
 * What a model can do, and what a provider's driver serves (#269, #1313): chat (`invoke`) or decide
 * (`decide`). A provider's driver says which; no model name does.
 */
export enum ModelKind {
  Chat = "chat",
  Decisions = "decisions",
}
