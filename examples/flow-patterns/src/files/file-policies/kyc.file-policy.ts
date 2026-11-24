import { FilePolicy } from "@agboss/core";
import { hours } from "@agboss/core/units";

/**
 * The ID photos a kyc check takes: images, one at a time, within the default 64 KB (a redacted copy
 * rides in the execution's state, so no file store is needed), kept an hour after the check ends.
 */
@FilePolicy({
  ttl: hours(1),
  maxFiles: 1,
  allowedMediaTypes: ["image/png", "image/jpeg"],
})
export class KycFilePolicy {}
