/**
 * The directives of one Content-Security-Policy header, by name.
 *
 * `"script-src 'self'; frame-src 'self'"` becomes
 * `Map { "script-src" => ["'self'"], "frame-src" => ["'self'"] }`.
 * Shared by the unit test that binds the dashboard policy and the scripts
 * that check the served header (#234).
 */
export function contentSecurityPolicyDirectives(policy) {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => directive !== "")
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/u);
        return [name, values];
      }),
  );
}

/**
 * What every dashboard document's policy must say: scripts and frames from
 * the site's own origin only, and no plug-in object at all (ADR-0049).
 */
export const expectedDashboardDirectives = [
  ["script-src", "'self'"],
  ["frame-src", "'self'"],
  ["object-src", "'none'"],
];

/**
 * True when a directive value admits a source other than the site's own
 * origin: a host name, a wildcard, or a scheme such as `data:`. Only the
 * quoted keywords the dashboard policy uses are allowed through, so a bare
 * host written without a scheme is caught too.
 */
export function namesAHost(value) {
  return !["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'"].includes(
    value,
  );
}

/**
 * The first way a served policy falls short of the dashboard's, or null when
 * it holds. Each script turns the reason into its own failure message.
 */
export function dashboardPolicyShortfall(policy) {
  if (policy === null || policy === "") return "no policy";
  const parsed = contentSecurityPolicyDirectives(policy);
  for (const [name, expected] of expectedDashboardDirectives) {
    const values = parsed.get(name) ?? [];
    if (!values.includes(expected)) return `${name} lacks ${expected}`;
    if (values.some(namesAHost)) return `${name} names a host`;
  }
  return null;
}
