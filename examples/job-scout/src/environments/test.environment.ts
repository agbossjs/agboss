import { defineEnvironment } from "agboss";

/** `testWith(JobScoutApplication, { env: "test" })`: a host no test reaches (fetches are stubbed or recorded). */
export default defineEnvironment({
  greenhouseApiUrl: "https://greenhouse.test",
});
