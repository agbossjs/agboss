import { createRequire } from "node:module";

/** Whether `sharp` — the optional peer dependency of the built-in image redactor — resolves from the core (#899 §6). */
export function isSharpResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve("sharp");
    return true;
  } catch {
    return false;
  }
}
