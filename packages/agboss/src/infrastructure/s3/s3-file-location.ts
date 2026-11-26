import { ConfigError } from "../../core/error-families/config-errors.js";
import type { ResolvedSettings } from "../../storage/settings.js";
import { Secret } from "../../environments/secret.js";
import type { S3Location } from "./s3-client.js";
import { prefixProblemOf } from "./s3-file-layout.js";

/** What the store reads from the object storage's `S3Driver` settings. */
export function locationOf(
  settings: ResolvedSettings | undefined,
): S3Location & { readonly prefix: string } {
  if (settings === undefined)
    throw new ConfigError.Option({
      message:
        "S3FileRepository needs the application's @ObjectStorage({ driver: S3Driver({ bucket, … }) })",
    });
  return locationOfSettings(settings);
}

/** The location an `@ObjectStorage({ driver: S3Driver(…) })` resolved to. */
function locationOfSettings(settings: ResolvedSettings): S3Location & { readonly prefix: string } {
  if (settings.kind !== "s3")
    throw new ConfigError.Option({
      message: `S3FileRepository is on the object storage's ${settings.kind} driver, not S3Driver`,
    });
  const text = (name: string): string | undefined => {
    const value = settings[name];
    if (value instanceof Secret) return value.reveal();
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === undefined) throw new ConfigError.Option({ message: `S3Driver needs ${name}` });
    return value;
  };
  return {
    bucket: required("bucket"),
    region: required("region"),
    endpoint: text("endpoint"),
    credentials: {
      accessKeyId: required("accessKeyId"),
      secretAccessKey: required("secretAccessKey"),
    },
    prefix: checkedPrefix(text("prefix") ?? "agboss-a2a-files/"),
  };
}

/** The prefix, if it leaves room for every key (#904). */
function checkedPrefix(prefix: string): string {
  const problem = prefixProblemOf(prefix);
  if (problem !== undefined) throw new Error(`S3FileRepository: ${problem}`);
  return prefix;
}
