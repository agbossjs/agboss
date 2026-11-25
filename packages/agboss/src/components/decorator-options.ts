/**
 * What each framework decorator takes (#1313, #1318, #1324), one list per decorator, held by the compiler to
 * `keyof` its options type: a key added to a type and not listed here does not compile, so the rule
 * `[decorator.unknown-option]` can never refuse an option the type offers, or allow one it does not.
 */
export * from "./option-lists/application.js";
export * from "./option-lists/flow.js";
export * from "./option-lists/components.js";
export * from "./option-lists/infrastructure.js";
export * from "./option-lists/pauses.js";
