/**
 * The Content Security Policy every dashboard document is served with.
 *
 * The dashboard renders the site's own page components on its editing
 * surfaces: the Design preview and the page editor's canvas. A component may
 * be written by an installation, and one that embeds a third-party frame or
 * script on an editing surface would make the owner's browser reach that
 * third party from inside the authenticated dashboard (#234). This policy
 * makes the browser refuse such a load before any request leaves it, whoever
 * wrote the component and however many times the surface re-renders.
 *
 * Only three directives are set, so nothing the dashboard already does is
 * touched: its images, styles, fonts and API requests are unrestricted.
 *
 * - `script-src 'self'`: a script may load from the site's own origin only.
 *   `'unsafe-inline'` stays, because Next writes its own inline scripts
 *   without a nonce. Neither keyword admits another host.
 * - `frame-src 'self'`: a frame may show the site's own origin only. The page
 *   editor's canvas is a `srcdoc` frame (`@puckeditor/core` sets `srcDoc` on
 *   its iframe), so it is the site's own origin, is admitted, and inherits
 *   this policy.
 * - `object-src 'none'`: no plug-in object or embed at all.
 *
 * The exact preview at `/__foundry/preview/...` and the public site are
 * outside `/dash`, so they keep the live Turnstile challenge (ADR-0049).
 */
export function dashboardContentSecurityPolicy({
  development,
}: Readonly<{ development: boolean }>): string {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  // The development server evaluates source maps and refresh code with
  // `eval`. The built dashboard does not, so production leaves this out.
  if (development) scriptSources.push("'unsafe-eval'");
  return [
    `script-src ${scriptSources.join(" ")}`,
    "frame-src 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * The `headers()` entries for `next.config.ts`. One source covers `/dash`
 * itself and every path below it; nothing outside the dashboard is matched.
 */
export function dashboardContentSecurityPolicyHeaders({
  development,
}: Readonly<{ development: boolean }>): Array<{
  source: string;
  headers: Array<{ key: string; value: string }>;
}> {
  return [
    {
      source: "/dash/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: dashboardContentSecurityPolicy({ development }),
        },
      ],
    },
  ];
}
