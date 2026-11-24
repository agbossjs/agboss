import { PiiAction, type PiiPartOptions } from "./actions.js";
import type { PiiRule } from "./pii-policy.decorator.js";

/**
 * The kinds of personal data a `@PiiPolicy` rule names (#120, #1301), each in one group. A rule is
 * written on its kind (`PiiKind.Email.tokenize()`) or on a whole group (`PiiGroup.Contact.mask()`);
 * inside one policy a kind rule beats a group rule. Each kind and group is one descriptor: compared
 * by identity, written by its `id` — the label of its tokens and placeholders (`<email:7f3a91>`,
 * `<israeli-id>`), its JSON and its text.
 */

/** What a kind and a group have alike: an id and the verbs that make a rule of it. */
export interface PiiTargetDescriptor {
  /** `email`, `contact`: the label of its tokens and placeholders, and its JSON. */
  readonly id: string;
  /**
   * One-way: `<email>` (no part, the value replaced by its label), `•••• 4242` (`{ keepLast: 4 }`),
   * `d•••@acme.com` (`{ keepDomain: true }`): part of it replaced.
   */
  mask(part?: PiiPartOptions): PiiRule;
  /** `<email:7f3a91>`: an HMAC token, revealed again when it comes back from the model. */
  tokenize(): PiiRule;
  /** The message or the call refused: with `refusal`, or the policy's `refusal(kind)`. */
  block(refusal?: string): PiiRule;
  /** The id: `JSON.stringify` writes a kind as its id. */
  toJSON(): string;
  /** The id. */
  toString(): string;
  /** The id. */
  [Symbol.toPrimitive](): string;
}

/** One kind of personal data: `PiiKind.Email`. */
export interface PiiKindDescriptor extends PiiTargetDescriptor {
  /** The group it is in: `PiiGroup.Contact` for `PiiKind.Email`. */
  readonly group: PiiGroupDescriptor;
}

/** A group of kinds: `PiiGroup.Financial` covers every financial kind. */
export interface PiiGroupDescriptor extends PiiTargetDescriptor {
  /** Its kinds, in the order the spec lists them. */
  readonly kinds: readonly PiiKindDescriptor[];
}

/** One kind of personal data (`PiiKind.Email`); `refusal(kind: PiiKind)` gets one. */
export type PiiKind = PiiKindDescriptor;

/** A group of kinds (`PiiGroup.Contact`). */
export type PiiGroup = PiiGroupDescriptor;

/** What a rule names: one kind or a group of them. */
export type PiiTarget = PiiKind | PiiGroup;

const KIND_IDS = {
  Email: "email",
  Phone: "phone",
  StreetAddress: "street-address",
  PostalCode: "postal-code",
  PersonName: "person-name",
  DateOfBirth: "date-of-birth",
  UsSsn: "us-ssn",
  UsItin: "us-itin",
  UkNino: "uk-nino",
  IsraeliId: "israeli-id",
  PassportNumber: "passport-number",
  DriverLicense: "driver-license",
  NationalId: "national-id",
  CardNumber: "card-number",
  Iban: "iban",
  SwiftBic: "swift-bic",
  BankAccount: "bank-account",
  UsEin: "us-ein",
  IpAddress: "ip-address",
  MacAddress: "mac-address",
  GeoCoordinates: "geo-coordinates",
  ApiKey: "api-key",
  Jwt: "jwt",
  PrivateKey: "private-key",
  Password: "password",
} as const;

type KindName = keyof typeof KIND_IDS;

/** The groups and their kinds, in the order the spec lists them. */
const GROUP_KINDS = {
  Contact: ["contact", ["Email", "Phone", "StreetAddress", "PostalCode"]],
  Identity: ["identity", ["PersonName", "DateOfBirth"]],
  Government: [
    "government",
    ["UsSsn", "UsItin", "UkNino", "IsraeliId", "PassportNumber", "DriverLicense", "NationalId"],
  ],
  Financial: ["financial", ["CardNumber", "Iban", "SwiftBic", "BankAccount", "UsEin"]],
  Network: ["network", ["IpAddress", "MacAddress", "GeoCoordinates"]],
  Credentials: ["credentials", ["ApiKey", "Jwt", "PrivateKey", "Password"]],
} as const satisfies Record<string, readonly [string, readonly KindName[]]>;

type GroupName = keyof typeof GROUP_KINDS;

/** The verbs of a kind or a group: each makes a rule on it. */
abstract class Target implements PiiTargetDescriptor {
  constructor(readonly id: string) {}

  mask(part?: PiiPartOptions): PiiRule {
    return this.rule(part === undefined ? PiiAction.mask() : PiiAction.mask(part));
  }

  tokenize(): PiiRule {
    return this.rule(PiiAction.tokenize());
  }

  block(refusal?: string): PiiRule {
    return this.rule(PiiAction.block(refusal));
  }

  toJSON(): string {
    return this.id;
  }

  toString(): string {
    return this.id;
  }

  [Symbol.toPrimitive](): string {
    return this.id;
  }

  protected abstract rule(action: PiiRule["action"]): PiiRule;
}

/** The group of each kind: filled once, when the groups are made below. */
const GROUP_OF = new Map<PiiKindDescriptor, PiiGroupDescriptor>();

class Kind extends Target implements PiiKindDescriptor {
  get group(): PiiGroupDescriptor {
    const group = GROUP_OF.get(this);
    if (group === undefined) throw new TypeError(`${this.id} has no group`);
    return group;
  }

  protected rule(action: PiiRule["action"]): PiiRule {
    return Object.freeze({ target: this, action });
  }
}

class Group extends Target implements PiiGroupDescriptor {
  constructor(
    id: string,
    readonly kinds: readonly PiiKindDescriptor[],
  ) {
    super(id);
  }

  protected rule(action: PiiRule["action"]): PiiRule {
    return Object.freeze({ target: this, action });
  }
}

const kinds = Object.fromEntries(
  Object.entries(KIND_IDS).map(([name, id]) => [name, new Kind(id)]),
) as Record<KindName, Kind>;

const groups = Object.fromEntries(
  Object.entries(GROUP_KINDS).map(([name, [id, members]]) => {
    const group = new Group(id, Object.freeze(members.map((member) => kinds[member])));
    for (const member of members) GROUP_OF.set(kinds[member], group);
    return [name, Object.freeze(group)];
  }),
) as Record<GroupName, PiiGroupDescriptor>;

for (const kind of Object.values(kinds)) Object.freeze(kind);

/** Every kind, in the order of `PiiKind`. */
export const ALL_KINDS: readonly PiiKind[] = Object.freeze(Object.values(kinds));

/** Every group, in the order of `PiiGroup`. */
export const ALL_GROUPS: readonly PiiGroup[] = Object.freeze(Object.values(groups));

const KIND_BY_ID: ReadonlyMap<string, PiiKind> = new Map(ALL_KINDS.map((kind) => [kind.id, kind]));

/**
 * The kinds: `PiiKind.Email.tokenize()`, `PiiKind.CardNumber.mask({ keepLast: 4 })`. `fromId` reads
 * a kind back from its id (a model's answer, a stored label); an id of no kind is `undefined`.
 */
export const PiiKind: {
  /** `email` */
  readonly Email: PiiKind;
  /** `phone` */
  readonly Phone: PiiKind;
  /** `street-address` */
  readonly StreetAddress: PiiKind;
  /** `postal-code` */
  readonly PostalCode: PiiKind;
  /** `person-name` */
  readonly PersonName: PiiKind;
  /** `date-of-birth` */
  readonly DateOfBirth: PiiKind;
  /** `us-ssn` */
  readonly UsSsn: PiiKind;
  /** `us-itin` */
  readonly UsItin: PiiKind;
  /** `uk-nino` */
  readonly UkNino: PiiKind;
  /** `israeli-id` */
  readonly IsraeliId: PiiKind;
  /** `passport-number` */
  readonly PassportNumber: PiiKind;
  /** `driver-license` */
  readonly DriverLicense: PiiKind;
  /** `national-id` */
  readonly NationalId: PiiKind;
  /** `card-number` */
  readonly CardNumber: PiiKind;
  /** `iban` */
  readonly Iban: PiiKind;
  /** `swift-bic` */
  readonly SwiftBic: PiiKind;
  /** `bank-account` */
  readonly BankAccount: PiiKind;
  /** `us-ein` */
  readonly UsEin: PiiKind;
  /** `ip-address` */
  readonly IpAddress: PiiKind;
  /** `mac-address` */
  readonly MacAddress: PiiKind;
  /** `geo-coordinates` */
  readonly GeoCoordinates: PiiKind;
  /** `api-key` */
  readonly ApiKey: PiiKind;
  /** `jwt` */
  readonly Jwt: PiiKind;
  /** `private-key` */
  readonly PrivateKey: PiiKind;
  /** `password` */
  readonly Password: PiiKind;
  /** The kind of an id (`"email"` → `PiiKind.Email`); `undefined` for an id of no kind. */
  readonly fromId: (id: string) => PiiKind | undefined;
} = Object.freeze({
  ...(kinds as Record<KindName, PiiKind>),
  fromId: (id: string): PiiKind | undefined => KIND_BY_ID.get(id),
});

/** The groups: `PiiGroup.Contact.mask()` covers every contact kind. */
export const PiiGroup: {
  /** `contact` */
  readonly Contact: PiiGroup;
  /** `identity` */
  readonly Identity: PiiGroup;
  /** `government` */
  readonly Government: PiiGroup;
  /** `financial` */
  readonly Financial: PiiGroup;
  /** `network` */
  readonly Network: PiiGroup;
  /** `credentials` */
  readonly Credentials: PiiGroup;
} = Object.freeze(groups);

/** Whether a rule's target is a group (else a kind). */
export const isPiiGroup = (target: PiiTarget): target is PiiGroup => target instanceof Group;

/** The kinds a rule's target covers. */
export const kindsOf = (target: PiiTarget): readonly PiiKind[] =>
  isPiiGroup(target) ? target.kinds : [target];

/**
 * Kinds without a format that can be validated: in free text only a model finds them, so a rule
 * naming one needs the policy's `detectWithModel`.
 */
export const MODEL_ONLY_KINDS: ReadonlySet<PiiKind> = new Set([
  PiiKind.StreetAddress,
  PiiKind.PersonName,
  PiiKind.DateOfBirth,
  PiiKind.PassportNumber,
  PiiKind.DriverLicense,
  PiiKind.NationalId,
  PiiKind.BankAccount,
]);
