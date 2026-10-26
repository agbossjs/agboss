import { z } from "zod";
import { InjectionToken } from "@agboss/core";

/**
 * Where job-scout looks. Change this file to point it at another country or set of companies —
 * the tool and prompts have no built-in country. Find boards with live jobs in a place:
 * `npm run job-scout:probe -- --place <place> <token> …`.
 */
export const JobSearchSchema = z.object({
  /** Greenhouse board token → company name (greenhouse.io has one board per company). */
  boards: z
    .record(z.string().min(1), z.string().min(1))
    .refine((boards) => Object.keys(boards).length > 0, "at least one board"),
  /** A place the user can name (country, region) → words that identify it in job locations. */
  places: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
});

export type JobSearch = z.output<typeof JobSearchSchema>;

/** The search config as a dependency (Greenhouse tool, prompts). */
export const JOB_SEARCH = new InjectionToken<JobSearch>("JOB_SEARCH");

/** Example: Israeli tech and global companies with Israeli R&D (probed 2026-09). */
export const jobSearchConfig: JobSearch = JobSearchSchema.parse({
  boards: {
    catonetworks: "Cato Networks",
    similarweb: "Similarweb",
    taboola: "Taboola",
    payoneer: "Payoneer",
    nice: "NICE",
    jfrog: "JFrog",
    transmitsecurity: "Transmit Security",
    appsflyer: "AppsFlyer",
    via: "Via",
    fireblocks: "Fireblocks",
    gitlab: "GitLab",
    axonius: "Axonius",
    melio: "Melio",
    riskified: "Riskified",
    mongodb: "MongoDB",
    torq: "Torq",
    forter: "Forter",
    saltsecurity: "Salt Security",
    yotpo: "Yotpo",
    apiiro: "Apiiro",
    datarails: "Datarails",
    elastic: "Elastic",
    safebreach: "SafeBreach",
    zscaler: "Zscaler",
    cymulate: "Cymulate",
    rubrik: "Rubrik",
    stripe: "Stripe",
    datadog: "Datadog",
    grafanalabs: "Grafana Labs",
    obligo: "Obligo",
    orcasecurity: "Orca Security",
    bigid: "BigID",
    databricks: "Databricks",
    innovid: "Innovid",
    jamf: "Jamf",
    lightricks: "Lightricks",
    okta: "Okta",
    island: "Island",
  },
  places: {
    israel: [
      "israel",
      "tel aviv",
      "tel-aviv",
      "herzliya",
      "haifa",
      "jerusalem",
      "netanya",
      "petah tikva",
      "petach tikva",
      "ramat gan",
      "ra'anana",
      "raanana",
      "yokneam",
      "rehovot",
      "beer sheva",
      "hod hasharon",
      "caesarea",
      "or yehuda",
      "rosh haayin",
      "kfar saba",
      "modiin",
      "airport city",
    ],
  },
});
