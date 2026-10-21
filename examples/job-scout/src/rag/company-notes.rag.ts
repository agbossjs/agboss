import { Rag, SqliteFtsConnector, type FtsOptions } from "agboss/rag";
import { InjectionToken } from "agboss";

/** Where the notes are and where their index lives. */
export const NOTES_INDEX = new InjectionToken<FtsOptions>("NOTES_INDEX");

/** The user's notes about companies — the reference full-text connector (SQLite FTS5, BM25). */
@Rag({
  name: "company-notes-rag",
  description: "The user's notes about companies: stack, culture, what people say",
  topK: 3,
  deps: [NOTES_INDEX],
})
export class CompanyNotes extends SqliteFtsConnector {}
