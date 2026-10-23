import { APPLICATION, ENV, flag, PROFILE, type CommandSpec } from "./options.js";

/** `agboss check`: every key-free validation of the application, with its opt-in checks. */
export const CHECK_COMMAND: CommandSpec = {
  summary:
    "every validation that needs no API key: assembly, graph rules, environment, prompts (+ models)",
  usage:
    "agboss check [--models] [--cassettes] [--federation <snapshot…>] [--strict] [--profile <name>] [--env <name>] [--application <path>] [--json]",
  positionals: "<snapshot…> (with --federation: agboss describe --json files, or folders of them)",
  options: [
    APPLICATION,
    flag("models", "also check models against their providers (lists them over the network)"),
    flag(
      "cassettes",
      "also check the VCR cassettes against the components ([vcr.stale-cassette]), no test run",
    ),
    flag(
      "federation",
      "also check the declared contracts against the neighbours' snapshots, no network",
    ),
    flag("strict", "the analyser's warnings are errors ([flow.path-too-deep], …)"),
    flag("prompts", "prompts: files exist, every {{variable}} is known — always checked"),
    PROFILE,
    ENV,
  ],
};
