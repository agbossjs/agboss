/**
 * #497: an application file whose import fails — as Node's own import of a decorated file fails
 * outside vitest's module graph. A real error, thrown by loading the module.
 */
throw new Error("broken.application.ts cannot be loaded");
