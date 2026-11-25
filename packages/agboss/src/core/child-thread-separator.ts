/**
 * What joins a parent's checkpoint thread to its child's execution id (ADR-0022): `<parent>/child/<id>`.
 * No key text may contain it (`KeyTextRule.ReservedSeparator`, #1321d), so a thread id names its
 * tree unambiguously.
 */
export const CHILD_THREAD_SEPARATOR = "/child/";
