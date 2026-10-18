import "dotenv/config";
import { studioGraphOf } from "agboss";
import { JobScout } from "./job-scout.workflow.js";
// the application gives the workflow its defaults (#261): load it before the graph is built
import "./job-scout.application.js";

/** job-scout in LangGraph Studio (`npm run studio` at the repo root; see langgraph.json). */
export const graph = await studioGraphOf(JobScout);
