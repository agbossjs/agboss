import { dirname, isAbsolute, relative } from "node:path";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { declarationOf } from "../decorators/declaration.js";
import type { ClassLocator } from "./locate.js";

/**
 * The names the generated file uses (#272 S2): each class it mentions gets an identifier and the
 * module it is imported from; the names of the tables module are imported only when used. A class
 * no loaded module exports is recorded (`[types.unexported-class]`); two classes of one name get
 * distinct identifiers (`MainRouter`, `MainRouter2`).
 */

/** What the generated file imports from the tables module. */
export enum TablesImport {
  ComponentBrand = "agbossComponent",
  DtoBrand = "agbossDto",
  NoInput = "NoInput",
  NoOutput = "NoOutput",
  Produced = "Produced",
  HistoryOf = "HistoryOf",
}

/** A class the generated file mentions and the module it is imported from. */
export interface ClassImport {
  readonly component: Class;
  readonly identifier: string;
  readonly file: string;
}

/** A DTO class the generated file mentions. */
export interface DtoImport extends ClassImport {
  readonly dto: DtoClass;
}

const SCRIPT_EXTENSIONS: Readonly<Record<string, string>> = { ts: "js", tsx: "jsx", mts: "mjs" };

/** How the generated file in `fromDirectory` imports `target`: a relative `.js` path or a package. */
export function moduleSpecifier(fromDirectory: string, target: string): string {
  if (!isAbsolute(target)) return target;
  const path = relative(fromDirectory, target).replace(
    /\.(ts|tsx|mts)$/,
    (_match, extension: string) => `.${SCRIPT_EXTENSIONS[extension] ?? extension}`,
  );
  return path.startsWith(".") ? path : `./${path}`;
}

export class ImportTable {
  private readonly imports = new Map<Class, ClassImport>();
  private readonly identifiers = new Set<string>();
  private readonly tables = new Set<TablesImport>();
  private readonly missing = new Set<Class>();
  private readonly dtoClasses = new Set<DtoClass>();
  private readonly plain = new Set<Class>();

  constructor(
    private readonly locator: ClassLocator,
    readonly outFile: string,
  ) {}

  /** The identifier of a class in the generated file. */
  ref(component: Class): string {
    const known = this.imports.get(component);
    if (known !== undefined) return known.identifier;
    const file = this.locator.fileOf(component, declarationOf(component)?.source);
    if (file === undefined) {
      this.missing.add(component);
      return component.name;
    }
    let identifier = component.name;
    for (let count = 2; this.identifiers.has(identifier); count += 1)
      identifier = `${component.name}${String(count)}`;
    this.identifiers.add(identifier);
    this.imports.set(component, { component, identifier, file });
    return identifier;
  }

  /** Like `ref`, for a class the file may leave out: nothing is recorded when no module exports it. */
  refIfExported(component: Class): string | undefined {
    if (this.locator.fileOf(component, declarationOf(component)?.source) === undefined)
      return undefined;
    return this.ref(component);
  }

  /** Like `ref`, for a class the file imports but never brands (an environment contract, #261). */
  refPlain(component: Class): string {
    this.plain.add(component);
    return this.ref(component);
  }

  /** Whether the file brands the class (every class it mentions but the plain ones). */
  isBranded(component: Class): boolean {
    return !this.plain.has(component);
  }

  /** The identifier of a DTO class (branded by its class name, S39). */
  dto(dto: DtoClass): string {
    this.dtoClasses.add(dto);
    return this.ref(dto);
  }

  /** Like `dto`, for a DTO the file may leave out: `undefined` when no loaded module exports it. */
  dtoIfExported(dto: DtoClass): string | undefined {
    if (this.locator.fileOf(dto, declarationOf(dto)?.source) === undefined) return undefined;
    return this.dto(dto);
  }

  /** The DTO classes mentioned and where each is imported from (the exported ones). */
  get dtos(): readonly DtoImport[] {
    return [...this.dtoClasses].flatMap((dto) => {
      const imported = this.imports.get(dto);
      return imported === undefined ? [] : [{ ...imported, dto }];
    });
  }

  /** A name of the tables module, imported once used. */
  use(name: TablesImport): string {
    this.tables.add(name);
    return name;
  }

  /** The import specifier of a module file. */
  specifier(file: string): string {
    return moduleSpecifier(dirname(this.outFile), file);
  }

  /** Every class mentioned, in the order first mentioned. */
  get classes(): readonly ClassImport[] {
    return [...this.imports.values()];
  }

  /** The classes no loaded module exports. */
  get unexported(): readonly Class[] {
    return [...this.missing];
  }

  /** The import lines: the tables module's names, then each module's classes, sorted. */
  importLines(tablesModule: string): readonly string[] {
    const byFile = new Map<string, string[]>();
    for (const { component, identifier, file } of this.imports.values()) {
      const name =
        identifier === component.name ? identifier : `${component.name} as ${identifier}`;
      byFile.set(file, [...(byFile.get(file) ?? []), name]);
    }
    const line = (names: readonly string[], from: string): string =>
      `import type { ${[...names].sort().join(", ")} } from "${from}";`;
    const modules = [...byFile]
      .map(([file, names]) => ({ from: this.specifier(file), names }))
      .sort((first, second) => first.from.localeCompare(second.from))
      .map(({ from, names }) => line(names, from));
    return this.tables.size === 0 ? modules : [line([...this.tables], tablesModule), ...modules];
  }
}
