/** The two forms of a `@ChannelRole` (an approval, or a question), checked as an untyped (JS) caller may declare them. */

export type RoleFields = Partial<
  Record<"approves" | "ask" | "answer" | "answerer" | "answeredBy", unknown>
>;

/** The form problem of a role's options (both forms, neither); none → `undefined`. */
export function formProblem(fields: RoleFields): string | undefined {
  const isApproval = fields.approves !== undefined;
  const isQuestion = fields.ask !== undefined || fields.answer !== undefined;
  if (isApproval && isQuestion) return "declares both approves and ask / answer — keep one form";
  if (!isApproval && (fields.ask === undefined || fields.answer === undefined))
    return "declares neither approves nor both ask and answer";
  return undefined;
}
