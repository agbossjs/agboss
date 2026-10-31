// #538 acceptance: the key-text cases against stores that fold or clean a business key on its way in,
// and (#620) one that compares keys accent-blind, keeping each as first given.
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

/** A key as an accent-insensitive collation compares it (MySQL's `_ai_ci`, ICU strength 1): no marks, ß as ss. */
const accentBlind = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replaceAll("ß", "ss");

/** The first text each compared form was stored with, per test database. */
const firstTexts = new WeakMap<object, Map<string, string>>();

/**
 * #620: a column with an accent-insensitive collation — it stores each key as first given, and a
 * later key of the same compared form finds that row: "Zoë-17" joins "Zoe-17".
 */
const comparedAccentBlind: KeyRewrite = (key, database) => {
  if (typeof key.businessKey !== "string") return key;
  const seen = firstTexts.get(database) ?? new Map<string, string>();
  firstTexts.set(database, seen);
  const form = [String(key.tenantId), String(key.name), accentBlind(key.businessKey)].join(
    "\u0000",
  );
  const text = seen.get(form) ?? key.businessKey;
  seen.set(form, text);
  return { ...key, businessKey: text };
};

const REWRITES: readonly (readonly [string, KeyRewrite])[] = [
  ...FOLDS.map(([name, fold]) => [name, businessKeyAs(fold)] as const),
  ["an accent-insensitive collation", comparedAccentBlind],
];

for (const [name, rewrite] of REWRITES) {
  fencedEffectContract({
    ...inMemoryTarget((seam) => {
      const stores = inMemoryFencedEffects(false)(seam);
      return {
        ...stores,
        effects: rewritingKeys(stores.effects, seam.database, rewrite),
      };
    }),
    name: `effects with ${name}`,
  });
  outboundCallContract({
    ...inMemoryTarget((seam) => {
      const stores = inMemoryOutboundCalls(seam);
      return { ...stores, calls: rewritingKeys(stores.calls, seam.database, rewrite) };
    }),
    name: `calls with ${name}`,
  });
}
