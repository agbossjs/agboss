import { chainText, type MeshEntry, type MeshHop } from "../../mesh/mesh-hop.js";
import { plainly } from "./family.js";
import { counted } from "./limit-error-specs.js";

/** The mesh limits' sentences and derived facts (#1325b): a peer's names never reach the message. */
const entryText = (entry: MeshEntry): string => `${entry.application} › ${entry.start}`;

/** The mesh facts a limit derives: its entry as a line, the chain and whether a peer said it. */
function meshFacts(f: {
  readonly meshEntry?: MeshEntry;
  readonly callChain?: readonly MeshHop[];
  readonly isRemote?: boolean;
}): Record<string, unknown> {
  return {
    entry: f.meshEntry === undefined ? "" : entryText(f.meshEntry),
    callChain: f.callChain ?? [],
    isRemote: f.isRemote === true,
  };
}

/** The record's mesh details: the entry and the chain as plain objects. */
function meshDetails(f: {
  readonly meshEntry?: MeshEntry;
  readonly callChain?: readonly MeshHop[];
}): Record<string, unknown> {
  return {
    ...(f.meshEntry === undefined ? {} : { entry: { ...f.meshEntry } }),
    chain: (f.callChain ?? []).map((hop) => ({ ...hop })),
  };
}

export const MESH_LIMIT_SPECS = {
  hops: plainly(
    [
      (f: {
        entry?: string;
        meshEntry?: MeshEntry;
        callChain?: readonly MeshHop[];
        maxMeshHops?: number;
        isRemote?: boolean;
      }) => {
        const hops = (f.callChain?.length ?? 0) + 1;
        return f.isRemote === true
          ? `a mesh peer refused the call: it would be hop ${String(hops)} of the call chain; its maxMeshHops is ${String(f.maxMeshHops ?? 0)}`
          : `${f.entry ?? ""} would be hop ${String(hops)} of the call chain; its maxMeshHops is ${String(f.maxMeshHops ?? 0)}: ${chainText(f.callChain ?? [])}`;
      },
      undefined,
      counted(
        (f: {
          meshEntry?: MeshEntry;
          callChain?: readonly MeshHop[];
          maxMeshHops?: number;
          isRemote?: boolean;
        }) => ({
          ...meshFacts(f),
          key: "maxMeshHops",
          limit: f.maxMeshHops ?? 0,
          actual: (f.callChain?.length ?? 0) + 1,
          hops: (f.callChain?.length ?? 0) + 1,
        }),
        meshDetails,
      ),
    ],
    ["entry"],
    "a call crossed more mesh hops than the limit allows",
  ),
  meshLoop: plainly(
    [
      (f: {
        entry?: string;
        meshEntry?: MeshEntry;
        callChain?: readonly MeshHop[];
        isRemote?: boolean;
      }) =>
        f.isRemote === true
          ? `a mesh peer refused the call: it was called again through the mesh (a call chain of ${String((f.callChain?.length ?? 0) + 1)} hops)`
          : `${f.entry ?? ""} was called again through the mesh: ${chainText([...(f.callChain ?? []), ...(f.meshEntry === undefined ? [] : [f.meshEntry])])}`,
      undefined,
      counted(
        (f: { meshEntry?: MeshEntry; callChain?: readonly MeshHop[]; isRemote?: boolean }) => ({
          ...meshFacts(f),
          key: "mesh.callChain",
          limit: 1,
          actual: 2,
        }),
        meshDetails,
      ),
    ],
    ["entry"],
    "a mesh call came back to an entry it was already in",
  ),
};
