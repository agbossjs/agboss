import { Action, type ActionHandler, type InputOf } from "agboss";
import { RegisteredOfferDto } from "../dtos/offer.dto.js";
import { RecruiterDeskService } from "../services/recruiter-desk.service.js";

/** An undo failed: a person takes the offer over. */
@Action({
  name: "alert-recruiter-action",
  description: "Tells the recruiter the offer could not be withdrawn",
  input: { offer: RegisteredOfferDto },
  deps: [RecruiterDeskService],
})
export class AlertRecruiterAction implements ActionHandler<AlertRecruiterAction> {
  constructor(private readonly recruiterDeskService: RecruiterDeskService) {}

  async execute(input: InputOf<AlertRecruiterAction>): Promise<void> {
    const { offerId } = input.offer.value;
    await this.recruiterDeskService.alert(
      `Offer ${offerId} could not be withdrawn: withdraw it by hand`,
    );
  }
}
