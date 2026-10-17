/** The credit service is down: the domain error `CreditLimitRouter.route()` lets out. */
export class CreditServiceUnavailableError extends Error {
  override readonly name = "CreditServiceUnavailableError";
}
