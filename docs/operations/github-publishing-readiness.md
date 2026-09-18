# Site publishing readiness

This document tells an installer how to connect site publishing: the step
that takes an approved draft and puts it on the live site through GitHub and
Cloudflare.

## Before publishing is connected

A new installation runs in local development, or without these settings, and
still works as an authoring surface. Pages, Blog and the Newsletter all load,
and a draft can be written, previewed and saved. Only the last step —
publishing a draft to the live site — is off.

While publishing is not connected:

- The Publish button is refused. Nothing is written to GitHub or Cloudflare.
- Pages, Blog and Settings each show "Publishing is not connected yet" and
  name the settings this installation still needs.
- In local development every screen shows "Publishing is off in local
  development" instead, because nothing needs to be installed to keep working
  locally.

## Settings to install

Install these values in the client-owned Worker configuration:

- `FOUNDRY_GITHUB_APP_ID` — the GitHub App's numeric ID.
- `FOUNDRY_GITHUB_INSTALLATION_ID` — the ID of that App's installation on the
  content repository.
- `FOUNDRY_GITHUB_PRIVATE_KEY` — the App's private key, used to sign a short
  lived installation token for each publish.
- `FOUNDRY_GITHUB_OWNER` — the GitHub account or organization that owns the
  content repository.
- `FOUNDRY_GITHUB_REPOSITORY` — the content repository's name.
- `FOUNDRY_PUBLIC_ORIGIN` — the site's public address, an absolute `https://`
  address with no path.
- `FOUNDRY_CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account that deploys the
  site.
- `FOUNDRY_CLOUDFLARE_SCRIPT_TAG` — the deployed Worker's script tag, read to
  confirm which deployment is live.
- `FOUNDRY_CLOUDFLARE_SCRIPT_NAME` — the deployed Worker's script name.
- `FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID` — the Cloudflare Pages build that
  runs after a publish.
- `FOUNDRY_CLOUDFLARE_API_TOKEN` — a Cloudflare API token scoped to read the
  deployment status and start the build above.
- `FOUNDRY_PUBLICATION_SIGNING_SECRET` — an installation-specific secret of at
  least 32 characters, used to sign the publication record so it cannot be
  forged.

Two related settings have a working default and never need to be installed on
their own: `FOUNDRY_PRODUCTION_BRANCH` defaults to `main`, and
`FOUNDRY_DEPLOYMENT_CHECK_NAME` defaults to `Cloudflare`.

## Publishing readiness report

`GET /api/foundry-cms/publishing-readiness` answers whether site
publishing is connected. Server code reads the same result through
`readContentPublicationReadiness` in
`apps/reference-site/src/content-publication-runtime.ts`.

```json
{
  "publishing": {
    "state": "not_configured",
    "missingSettings": ["FOUNDRY_GITHUB_APP_ID"],
    "setupGuide": "docs/operations/github-publishing-readiness.md"
  }
}
```

- `state` is `connected`, `not_configured`, or `local_development`.
- `missingSettings` holds setting **names** only, in the order of the list
  above. The report never returns a setting value, a token or a key.
- `connected` means every setting above is installed, so
  `readGitHubContentPublisherConfiguration` can build a configuration. It
  does not mean GitHub or Cloudflare were reached — this check makes no
  network call. A publish attempt is still the first real test of the
  connection.

## Installing the App

1. Create a GitHub App scoped to the content repository, with permission to
   read and write repository contents and read commit statuses.
2. Install the App on the content repository and note the installation ID.
3. Generate a private key for the App and install it, the App ID, the
   installation ID, the repository owner and the repository name as the
   settings above.
4. Create a Cloudflare API token scoped to read the Worker's deployment
   status and start the named Pages build, and install it with the account,
   script and build-trigger settings above.
5. Install the public origin and the publication signing secret.
6. Reload the dashboard. Pages, Blog and Settings each read the settings
   above and report `connected` once every one of them is installed.
