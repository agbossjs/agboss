import {
  NO_RECIPIENTS,
  type PauseRecipients,
  type PauseRecord,
} from "../infrastructure/pause-record.js";

/**
 * Who hears of a pause's change (#940 fills it): every transition call site asks here, so the
 * notices of #940 and the deadlines of #941 change one function and not the call sites. Until then
 * nobody is told through the store; `withdraw` (#337) is still called as before.
 */
export const recipientsOf: (pause: PauseRecord) => PauseRecipients = () => NO_RECIPIENTS;
