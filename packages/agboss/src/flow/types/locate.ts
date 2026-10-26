import { basename, isAbsolute } from "node:path";
import type { Class } from "../../components/injection.js";
import type { LoadedModule } from "../analyse/rules/context.js";

/**
 * Where a class can be imported from (#272 S2): the loaded project modules that export it under
 * its own name (`moduleNamespace[Cls.name] === Cls`). A class exported from several modules (its
 * own file and a barrel) is imported from the file it was declared in when that is known, else from
 * a package entry (`@agboss/core/dto`, kept in the given order), else from the first file that is not an
 * `index` barrel, by path.
 */

const isBarrel = (file: string): boolean => /^index\.[cm]?[jt]sx?$/.test(basename(file));

export class ClassLocator {
  private readonly filesByClass = new Map<Class, string[]>();

  constructor(modules: readonly LoadedModule[]) {
    const files = modules.filter((module) => isAbsolute(module.file));
    const sorted = [
      ...modules.filter((module) => !isAbsolute(module.file)),
      ...files.sort((first, second) => first.file.localeCompare(second.file)),
    ];
    for (const module of sorted) {
      for (const [exportName, exported] of Object.entries(module.exports)) {
        if (typeof exported !== "function" || exported.name !== exportName) continue;
        const component = exported as Class;
        this.filesByClass.set(component, [
          ...(this.filesByClass.get(component) ?? []),
          module.file,
        ]);
      }
    }
  }

  /** The module to import `component` from; undefined when no loaded module exports it. */
  fileOf(component: Class, declaredIn?: string): string | undefined {
    const files = this.filesByClass.get(component) ?? [];
    if (declaredIn !== undefined && files.includes(declaredIn)) return declaredIn;
    return (
      files.find((file) => !isAbsolute(file)) ?? files.find((file) => !isBarrel(file)) ?? files[0]
    );
  }
}
