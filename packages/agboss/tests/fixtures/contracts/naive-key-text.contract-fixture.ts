// #538 acceptance: the key-text cases against stores that fold or clean a business key on its way in.
import {
  fencedEffectContract,
  outboundCallContract,
} from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import { rewritingKeys, type KeyRewrite } from "./naive-guarantees.js";

/** A business key rewritten as a lenient store or a database collation would. */
const businessKeyAs =
  (fold: (businessKey: string) => string): KeyRewrite =>
  (key) =>
    typeof key.businessKey === "string" ? { ...key, businessKey: fold(key.businessKey) } : key;

const FOLDS: readonly (readonly [string, (businessKey: string) => string])[] = [
  ["a case-insensitive collation", (text) => text.toLowerCase()],
  ["keys folded to NFKC", (text) => text.normalize("NFKC")],
  ["keys trimmed", (text) => text.trim()],
  [
    "keys cleaned of controls and format characters, then NFC",
    (text) =>
      text
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .normalize("NFC")
        .slice(0, 200)
        .replace(/\p{Cs}/gu, ""),
  ],
];

for (const [name, fold] of FOLDS) {
  fencedEffectContract({
    ...inMemoryTarget((seam) => {
      const stores = inMemoryFencedEffects(false)(seam);
      return {
        ...stores,
        effects: rewritingKeys(stores.effects, seam.database, businessKeyAs(fold)),
      };
    }),
    name: `effects with ${name}`,
  });
  outboundCallContract({
    ...inMemoryTarget((seam) => {
      const stores = inMemoryOutboundCalls(seam);
      return { ...stores, calls: rewritingKeys(stores.calls, seam.database, businessKeyAs(fold)) };
    }),
    name: `calls with ${name}`,
  });
}
