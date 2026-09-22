/**
 * The directives of one Content-Security-Policy header, by name.
 *
 * `"script-src 'self'; frame-src 'self'"` becomes
 * `Map { "script-src" => ["'self'"], "frame-src" => ["'self'"] }`.
 * Shared by the unit test that binds the dashboard policy and the browser
 * script that checks the served header (#234).
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
