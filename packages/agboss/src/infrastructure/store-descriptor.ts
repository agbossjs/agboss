import { LeaseCheck, type StoreDescriptor } from "./execution-lease.repository.js";

/** A store class's `static store`, as declared — `{ backend: undefined }` for a class without one. */
export function storeDescriptorOf(store: object): StoreDescriptor {
  // what is no descriptor reads as undeclared here: `[application.store-descriptor-invalid]` names it
  try {
    return descriptorIn(Reflect.get(store, "store"));
  } catch {
    return { backend: undefined };
  }
}

/** A declared `static store`, read once: a text backend and a known `leaseCheck`, else undeclared. */
function descriptorIn(declared: unknown): StoreDescriptor {
  // a declaration that is no object (none at all, `null`, a number) throws here: undeclared
  const backend: unknown = Reflect.get(declared as object, "backend");
  const leaseCheck: unknown = Reflect.get(declared as object, "leaseCheck");
  return {
    backend: typeof backend === "string" ? backend : undefined,
    ...(isLeaseCheck(leaseCheck) ? { leaseCheck } : {}),
  };
}

const isLeaseCheck = (value: unknown): value is LeaseCheck =>
  (Object.values(LeaseCheck) as unknown[]).includes(value);

/** Whether a store class opts out of the atomic lease check (#526: `leaseCheck` of its `store`). */
export const optsOutOfLeaseCheck = (store: object): boolean =>
  storeDescriptorOf(store).leaseCheck === LeaseCheck.WithoutDoubleChargeProtection;
