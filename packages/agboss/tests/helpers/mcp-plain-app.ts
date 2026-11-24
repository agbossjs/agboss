import type { App } from "../../src/app/types.js";
import type { TenantContextBranded } from "../../src/app/tenant-args.js";

/** An application of a test that declares no `tenantContext`: its MCP connections need no tenant in their session. */
export const plainApp = <T extends App>(app: T): T & TenantContextBranded<false> => app;
