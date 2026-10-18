/**
 * The kinds of personal data a `@PiiPolicy` rule names (#120), each in one group. A rule names a
 * kind (`PiiKind.Email`) or a whole group (`PiiGroup.Contact`); inside one policy a kind rule beats
 * a group rule. The value of a kind is its label: `<email:7f3a91>`, `<israeli-id>`.
 */
export enum PiiKind {
  Email = "email",
  Phone = "phone",
  StreetAddress = "street-address",
  PostalCode = "postal-code",
  PersonName = "person-name",
  DateOfBirth = "date-of-birth",
  UsSsn = "us-ssn",
  UsItin = "us-itin",
  UkNino = "uk-nino",
  IsraeliId = "israeli-id",
  PassportNumber = "passport-number",
  DriverLicense = "driver-license",
  NationalId = "national-id",
  CardNumber = "card-number",
  Iban = "iban",
  SwiftBic = "swift-bic",
  BankAccount = "bank-account",
  UsEin = "us-ein",
  IpAddress = "ip-address",
  MacAddress = "mac-address",
  GeoCoordinates = "geo-coordinates",
  ApiKey = "api-key",
  Jwt = "jwt",
  PrivateKey = "private-key",
  Password = "password",
}

/** The groups of kinds: `pii(PiiGroup.Financial, …)` covers every financial kind. */
export enum PiiGroup {
  Contact = "contact",
  Identity = "identity",
  Government = "government",
  Financial = "financial",
  Network = "network",
  Credentials = "credentials",
}

/** What a rule names: one kind or a group of them. */
export type PiiTarget = PiiKind | PiiGroup;

/** The kinds of each group, in the order the spec lists them. */
export const KINDS_OF_GROUP: Readonly<Record<PiiGroup, readonly PiiKind[]>> = {
  [PiiGroup.Contact]: [PiiKind.Email, PiiKind.Phone, PiiKind.StreetAddress, PiiKind.PostalCode],
  [PiiGroup.Identity]: [PiiKind.PersonName, PiiKind.DateOfBirth],
  [PiiGroup.Government]: [
    PiiKind.UsSsn,
    PiiKind.UsItin,
    PiiKind.UkNino,
    PiiKind.IsraeliId,
    PiiKind.PassportNumber,
    PiiKind.DriverLicense,
    PiiKind.NationalId,
  ],
  [PiiGroup.Financial]: [
    PiiKind.CardNumber,
    PiiKind.Iban,
    PiiKind.SwiftBic,
    PiiKind.BankAccount,
    PiiKind.UsEin,
  ],
  [PiiGroup.Network]: [PiiKind.IpAddress, PiiKind.MacAddress, PiiKind.GeoCoordinates],
  [PiiGroup.Credentials]: [PiiKind.ApiKey, PiiKind.Jwt, PiiKind.PrivateKey, PiiKind.Password],
};

const GROUPS = new Set<string>(Object.values(PiiGroup));

/** Whether a rule's target is a group (else a kind). */
export const isPiiGroup = (target: PiiTarget): target is PiiGroup => GROUPS.has(target);

/** The kinds a rule's target covers. */
export const kindsOf = (target: PiiTarget): readonly PiiKind[] =>
  isPiiGroup(target) ? KINDS_OF_GROUP[target] : [target];

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
