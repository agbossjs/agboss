import {
  failWith,
  ModelFailure,
  replyWith,
  type ModelRequest,
  type ScriptedTurn,
} from "@agboss/core/testing";
import { VendorRejectedDto } from "../../../../src/vendor/dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../../../src/vendor/dto/vendor-score.dto.js";

/** "Acme" scores, "Initech" is not a fit, "Globex"'s check fails (its model times out). */
export const checker = (request: ModelRequest): ScriptedTurn => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  if (input.includes("Globex")) return failWith(ModelFailure.Timeout);
  return input.includes("Acme")
    ? replyWith(VendorScoreDto, { name: "Acme", score: 8 })
    : replyWith(VendorRejectedDto, { name: "Initech", reason: "too small" });
};
