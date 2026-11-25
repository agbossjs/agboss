import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { meshOf } from "../mesh/mesh.decorator.js";
import { isFunction } from "../storage/storage-assembly.js";
import { databaseStorageOf } from "../storage/storage-decorators.js";
import type { ApplicationOptions } from "./application.js";

/**
 * The application's database storage and mesh as the selected profiles leave them (#1318c): a class
 * derived once per (class, overlay) whose record carries the overlaid values — the declared class and
 * its record are never changed, so two assemblies under two profiles never see each other. Both are
 * held by the application alone (`storage`, `mesh`), so replacing them in the effective options reaches
 * every reader.
 */

const derived = new WeakMap<Class, WeakMap<object, Class>>();
const overlaid = new WeakSet<Class>();

const subclassOf = (cls: Class): Class => {
  const subclass = class extends (cls as new (...args: never[]) => object) {};
  Object.defineProperty(subclass, "name", { value: cls.name });
  overlaid.add(subclass);
  return subclass;
};

/** The one derived class of `cls` under `overlay`: the same pair always gives the same class. */
function derivedOnce(cls: Class, overlay: object, make: () => Class): Class {
  const known = derived.get(cls)?.get(overlay);
  if (known !== undefined) return known;
  const made = make();
  const byOverlay = derived.get(cls) ?? new WeakMap<object, Class>();
  byOverlay.set(overlay, made);
  derived.set(cls, byOverlay);
  return made;
}

function overlaidDatabase(cls: Class, folded: FoldedConfig): Class {
  const meta = overlaid.has(cls) ? undefined : databaseStorageOf(cls);
  const overlay = meta === undefined ? undefined : folded.databaseStorages[meta.name];
  if (meta === undefined || overlay === undefined) return cls;
  return derivedOnce(cls, overlay, () => {
    const subclass = subclassOf(cls);
    recordComponent(subclass, { kind: "database-storage", meta: { ...meta, ...overlay } });
    return subclass;
  });
}

function overlaidMesh(cls: Class, folded: FoldedConfig): Class {
  const meta = overlaid.has(cls) ? undefined : meshOf(cls);
  const overlay = meta === undefined ? undefined : folded.mesh[meta.name];
  if (meta === undefined || overlay === undefined) return cls;
  return derivedOnce(cls, overlay, () => {
    const subclass = subclassOf(cls);
    recordComponent(subclass, { kind: "mesh", meta: { ...meta, ...overlay } });
    return subclass;
  });
}

/** The `storage` and `mesh` the profiles' shelves change, as options to lay over the declared ones; `{}` when they change none. */
export function componentOptionsOf(
  options: Pick<ApplicationOptions, "storage" | "mesh">,
  folded: FoldedConfig,
): Pick<ApplicationOptions, "storage" | "mesh"> {
  const { storage, mesh } = options;
  const database = isFunction(storage) ? storage : storage?.database;
  const changedDatabase = database === undefined ? undefined : overlaidDatabase(database, folded);
  const changedMesh = mesh === undefined ? undefined : overlaidMesh(mesh, folded);
  return {
    ...(changedDatabase === undefined || changedDatabase === database
      ? {}
      : {
          storage: isFunction(storage)
            ? changedDatabase
            : { ...storage, database: changedDatabase },
        }),
    ...(changedMesh === undefined || changedMesh === mesh ? {} : { mesh: changedMesh }),
  };
}

/** A name a profile's `databaseStorages` / `mesh` shelf holds is the application's own. */
export function checkComponentShelves(folded: FoldedConfig, options: ApplicationOptions): void {
  const { storage, mesh } = options;
  const database = isFunction(storage) ? storage : storage?.database;
  const has = [
    [
      "databaseStorages",
      "@DatabaseStorage",
      database === undefined ? undefined : databaseStorageOf(database)?.name,
    ],
    ["mesh", "@Mesh", mesh === undefined ? undefined : meshOf(mesh)?.name],
  ] as const;
  for (const [shelf, decorator, name] of has) {
    const [lost] = Object.keys(folded[shelf]).filter((key) => key !== name);
    if (lost !== undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Unknown,
        message: `profile ${folded.profiles.join(",")}: ${shelf}.${lost}: no such ${decorator} in the application — it has: ${name ?? "none"}`,
      });
  }
}
