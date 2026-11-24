import {
  CountryCode,
  CurrencyCode,
  IsoDate as CalendarDate,
  IsoDateTime,
  DecimalString,
  Email,
  MediaType,
  PhoneNumber,
  Text,
  TimeZone,
  Url,
} from "../decorators.js";
import { crossFieldRule } from "../schema.js";

/** An amount of money: exact, as a decimal string, with its currency. */
export class MoneyDto {
  @DecimalString({ prompt: "the amount, e.g. 19.99", scale: 2 })
  amount!: string;

  @CurrencyCode({ prompt: "the currency, ISO 4217, e.g. USD" })
  currency!: string;
}

/** Calendar days, both ends included; no time of day. */
export class DateRangeDto {
  @CalendarDate({ prompt: "the first day, e.g. 2026-09-01" })
  from!: string;

  @CalendarDate({ prompt: "the last day, e.g. 2026-09-30" })
  to!: string;

  @TimeZone({
    prompt: "the time zone these days are in, IANA, e.g. Asia/Jerusalem",
    optional: true,
  })
  timeZone?: string;
}
crossFieldRule(DateRangeDto, ({ from, to }) =>
  from <= to ? undefined : { field: "to", reason: "the last day is before the first" },
);

/** Exact moments: from included, to excluded. */
export class DateTimeRangeDto {
  @IsoDateTime({ prompt: "start, with a UTC offset, e.g. 2026-09-01T09:00:00+03:00" })
  from!: string;

  @IsoDateTime({ prompt: "end, with a UTC offset, e.g. 2026-09-01T18:00:00+03:00" })
  to!: string;
}
crossFieldRule(DateTimeRangeDto, ({ from, to }) =>
  Date.parse(from) < Date.parse(to)
    ? undefined
    : { field: "to", reason: "the end is not after the start" },
);

/** A file attached to a message or an replyWith — by link or by content. */
export class AttachmentDto {
  @Text({ prompt: "the file name, e.g. invoice.pdf" })
  name!: string;

  @MediaType({ prompt: "the file type, e.g. application/pdf" })
  mediaType!: string;

  @Url({ prompt: "where to download it", optional: true })
  url?: string;

  @Text({ prompt: "the content, base64-encoded, when there is no link", optional: true })
  content?: string;
}
crossFieldRule(AttachmentDto, ({ url, content }) =>
  (url === undefined) !== (content === undefined)
    ? undefined
    : { field: "url", reason: "give exactly one of url and content" },
);

/** A postal address. */
export class AddressDto {
  @Text({ prompt: "street and house number" })
  street!: string;

  @Text({ prompt: "city" })
  city!: string;

  @Text({ prompt: "region or state, if the country uses them", optional: true })
  region?: string;

  @Text({ prompt: "postal code", optional: true })
  postalCode?: string;

  @CountryCode({ prompt: "country, ISO 3166-1 alpha-2, e.g. IL" })
  country!: string;
}

/** A person's name. */
export class PersonNameDto {
  @Text({ prompt: "given name" })
  given!: string;

  @Text({ prompt: "family name", optional: true })
  family?: string;
}

/** How to reach a person. */
export class ContactInfoDto {
  @Email({ prompt: "email address", optional: true })
  email?: string;

  @PhoneNumber({
    prompt: "phone number in international format, e.g. +972521234567",
    optional: true,
  })
  phone?: string;
}
crossFieldRule(ContactInfoDto, ({ email, phone }) =>
  email !== undefined || phone !== undefined
    ? undefined
    : { field: "email", reason: "give an email, a phone or both" },
);

/** Where a statement in an replyWith comes from, in a knowledge base. */
export class RagSourceReferenceDto {
  @Text({ prompt: "what the source is: a document title, a page name" })
  title!: string;

  @Url({ prompt: "a link to the source", optional: true })
  url?: string;

  @Text({ prompt: "the exact words the replyWith relies on", optional: true, maxLength: 300 })
  quote?: string;
}
