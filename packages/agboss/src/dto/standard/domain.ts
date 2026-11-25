import {
  CountryCode,
  CurrencyCode,
  IsoDate as CalendarDate,
  IsoDateTime,
  DecimalString,
  Email,
  PhoneNumber,
  Text,
  TimeZone,
  Validate,
} from "../decorators.js";
import { minorUnitsOf } from "../codes.js";

/** The most digits after the point any ISO 4217 currency has (CLF, UYW). */
const MAX_MINOR_UNITS = 4;

/**
 * An amount of money: exact, as a decimal string, with its currency; the digits after the point
 * follow the currency's ISO 4217 minor unit (`JPY` 0, `USD` 2, `KWD` 3), and a code that is no money
 * (a metal, a fund, `XXX`) is refused.
 */
@Validate<MoneyDto>(({ amount, currency }) => {
  const units = minorUnitsOf(currency);
  if (units === undefined) return { field: "currency", reason: "a currency with no minor unit" };
  const digits = amount.split(".")[1]?.length ?? 0;
  return digits <= units
    ? undefined
    : {
        field: "amount",
        reason: `${currency} has at most ${String(units)} digits after the point`,
      };
})
export class MoneyDto {
  @DecimalString({ prompt: "the amount, e.g. 19.99", scale: MAX_MINOR_UNITS })
  amount!: string;

  @CurrencyCode({ prompt: "the currency, ISO 4217, e.g. USD" })
  currency!: string;
}

/** Calendar days, both ends included; no time of day. */
@Validate<DateRangeDto>(({ from, to }) =>
  from <= to ? undefined : { field: "to", reason: "the last day is before the first" },
)
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

/** Exact moments: from included, to excluded. */
@Validate<DateTimeRangeDto>(({ from, to }) =>
  Date.parse(from) < Date.parse(to)
    ? undefined
    : { field: "to", reason: "the end is not after the start" },
)
export class DateTimeRangeDto {
  @IsoDateTime({ prompt: "start, with a UTC offset, e.g. 2026-09-01T09:00:00+03:00" })
  from!: string;

  @IsoDateTime({ prompt: "end, with a UTC offset, e.g. 2026-09-01T18:00:00+03:00" })
  to!: string;
}

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
@Validate<ContactInfoDto>(({ email, phone }) =>
  email !== undefined || phone !== undefined
    ? undefined
    : { field: "email", reason: "give an email, a phone or both" },
)
export class ContactInfoDto {
  @Email({ prompt: "email address", optional: true })
  email?: string;

  @PhoneNumber({
    prompt: "phone number in international format, e.g. +972521234567",
    optional: true,
  })
  phone?: string;
}
