/** A child workflow cannot be built: it runs only in its application, or it launches an ancestor. */
export class ChildWorkflowUnavailableError extends Error {
  override name = "ChildWorkflowUnavailableError";
}
