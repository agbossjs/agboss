import { Action, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { VendorCheckFailedDto } from "../dtos/vendor-check-failed.dto.js";
import { VendorDto } from "../dtos/vendor.dto.js";

/**
 * The child's soft failure: a check that failed becomes a result of its own, so one failed vendor
 * does not cancel the others (FailFast) — the parent's join gets every vendor's result.
 */
@Action({
  name: "mark-vendor-failed-action",
  description: "Records that a vendor could not be checked",
  input: {
    vendor: VendorDto,
  },
  output: VendorCheckFailedDto,
})
export class MarkVendorFailedAction implements ActionHandler<MarkVendorFailedAction> {
  execute(input: InputOf<MarkVendorFailedAction>): Promise<OutputOf<MarkVendorFailedAction>> {
    return Promise.resolve({ name: input.vendor.value.name, reason: "the check failed" });
  }
}
