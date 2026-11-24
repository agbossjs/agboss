import type { AnyTenantApp, App } from "../../src/app/types.js";

/** An application of a test that declares no `tenantContext`: its MCP connections need no tenant in their session. */
export const plainApp = (app: App): AnyTenantApp => app;
