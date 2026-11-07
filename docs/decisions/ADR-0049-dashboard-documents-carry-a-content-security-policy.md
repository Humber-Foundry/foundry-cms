# ADR-0049: Every dashboard document carries a Content Security Policy that admits the site's own origin only

- Status: Accepted
- Date: 2026-09-22
- Issue: [#234](https://github.com/Humber-Foundry/foundry-cms/issues/234)
- Related: [ADR-0009](ADR-0009-design-presets-and-token-vocabulary.md)

## Context

The owner saw the browser message "Blocked script execution" on every render
of the Design screen of the acceptance installation. The message is what
Chrome writes when a sandboxed frame holds a document that tries to run a
script. The frame was an installation-owned newsletter embed from a third
party, drawn inside the Design preview and the page editor's canvas with a
`sandbox` attribute. The sandbox stopped the script. It did not stop the
frame from being loaded, so the owner's browser reached the third party from
inside the authenticated dashboard on every render.

This repository holds no such component. Its own newsletter signup form reads
`editingSurface` and draws no challenge widget on an editing surface, and the
Design preview is a scaled `<div>` rendering `SiteRenderer`, not a frame
(ADR-0009). A probe against the reference site found no third-party request,
no frame and no console error on `/dash/design`, before and after two design
changes.

Nothing refused the frame. `editingSurface` is a hint a page component may
read. An installation writes its own components, and one that ignores the
hint can still put a third-party frame or script on an editing surface. The
product had no rule that stopped the browser from loading it.

## Decision

Every document under `/dash` is served with this response header:

    Content-Security-Policy: script-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'

The development server adds `'unsafe-eval'` to `script-src`, because it
evaluates source maps and refresh code that way. The built dashboard does not.

`dashboardContentSecurityPolicy` in
`apps/reference-site/src/dashboard-content-security-policy.ts` holds the
policy, `next.config.ts` serves it through `headers()`, and a unit test binds
the two. The policy sets only these three directives. The dashboard's images,
styles, fonts and API requests are not restricted, so nothing the dashboard
already does changes.

The browser now refuses a third-party frame or script anywhere in a dashboard
document before any request leaves it, whoever wrote the component and
however many times the surface re-renders. The page editor's canvas is a
`srcdoc` frame: `@puckeditor/core` sets `srcDoc` on its iframe and fills it
from the dashboard document. It is the site's own origin, so
`frame-src 'self'` admits it, and it inherits the policy, so the same rule
holds inside it. The dashboard browser scripts drive that editor under the
policy on every run.

`scripts/verify-design-preview-browser.mjs` is the regression test. It opens
`/dash/design`, changes a design option twice, and requires no console error
and no request to any host outside the site's origin. It then puts a
third-party frame and script into the preview by hand and requires the
browser to refuse both, with no request sent. The hosts it uses end in
`.invalid`, a name that never resolves. `scripts/verify-worker-runtime.mjs`
requires the built Worker to serve `/dash/design` with the policy and the
public page without it, so the header is proven on the deployment path as
well as on the development server.

## Consequences

- The public site and the exact preview at `/__foundry/preview/...` are
  outside `/dash`, so they keep the live Turnstile challenge.
  `scripts/verify-design-preview-browser.mjs` checks that `/` carries no
  policy. `scripts/verify-private-dashboard-browser.mjs` opens a saved exact
  preview from the editor and the public home page, requires no policy on the
  exact preview, and requires the challenge container on both.
- An installation component that embeds a third party on an editing surface
  now shows an empty frame there, and the browser console names the policy
  that refused it. The component should read `editingSurface` and draw a
  placeholder instead; the renderer contract says so.
- When the identity provider is not configured, the Worker's own identity
  boundary answers `/dash` and `/dash/` with a plain 404 or 503 document
  before Next runs. Those documents hold no script and no page component,
  and they carry no policy. Every other dashboard path reaches Next and
  carries it, which is what `verify:worker` checks on `/dash/design`.
- `'unsafe-inline'` stays in `script-src` because Next writes its own inline
  scripts without a nonce. It admits no other host. A nonce-based policy
  would let it go, and is a separate change.
- A future dashboard feature that needs a script or frame from another host
  must change this policy on purpose, with the unit test, and say why.

## Alternatives considered

- **Remove the Turnstile script when the signup form unmounts.** The script is
  never added on an editing surface, so it was not the cause, and removing it
  guards nothing an installation component does.
- **Watch the preview with a `MutationObserver` and strip outside frames and
  scripts.** The observer runs after the element is in the document, and a
  script starts loading the moment it is inserted, so a request can leave
  before the observer runs. It cannot promise what the policy promises.
- **Render the preview inside a sandboxed frame.** ADR-0009 rejected a frame
  for the Design preview, and a sandbox still loads a third-party document; it
  only stops its script. That is exactly what the owner saw.
- **A `<meta http-equiv>` policy in the dashboard layout.** It works in
  Chromium, but a header is enforced from the first byte, needs no place in
  the markup, and is what the Worker already does for the MCP endpoints.
