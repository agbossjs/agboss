/**
 * The tenant of every execution until #261 PR 3 brings tenants (`app.execute(…, { tenant })`): a
 * single-tenant application has the tenant `"default"` (#266 S34), and every lease and tree key
 * is stored under it.
 */
export const DEFAULT_TENANT_ID = "default";
