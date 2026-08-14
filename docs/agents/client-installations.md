# Client installations and the product boundary

Foundry CMS is proven against real client sites. Each installation has its
own private repository in this GitHub organization. The current acceptance
installation is the one issue #101 tracks. Its repository is private and is
never named in this public repository. To find it, list the organization's
private repositories; the installation repository's README identifies itself
as the Foundry CMS acceptance testbed and references issue #101. That README
also documents the installation's setup, gates, and deploy safety. This
document states the boundary between an installation and this product
repository. It also states the workflow that keeps the boundary intact.

This repository is public. That is why the boundary below is strict.

## The boundary

**This repository must stay client-neutral.** It must never contain a
client's name, copy, photographs, domain, analytics, credentials, or design
language. The reference site in `apps/reference-site` uses only the neutral
"Foundry Reference" content in `apps/reference-site/foundry/`.

**A client installation has its own repository.** That repository pins one exact foundation
release in `.foundry-foundation-release.json`, vendors or installs the
`@humber-foundry/*` packages that release produced, and owns everything under
its `foundry/` directory and its media. See
`apps/reference-site/foundry/README.md` for which files an installation owns
and `docs/architecture/guided-client-provisioning.md` for provisioning.

## Direction of flow

- **Code flows one way: product → installation.** Features, fixes, and the
  synchronized foundation move to an installation through a foundation
  release and an updated pin. Never copy files from a client installation
  into this repository.
- **Feedback flows the other way: installation → product, as issues.** A
  defect or feature gap found while testing a client installation is a
  product issue. File it here, written client-neutrally: describe the CMS
  behaviour, not the client's content. Do not paste client copy, photographs,
  media, or screenshots of client pages into issues or test fixtures. Do not
  name the client or the installation repository anywhere in this repository
  — files, issues, comments, pull requests, or commit messages.
- **Client-content work stays in the client repository.** Words, photos,
  design language, DNS, and deploys for the client site are issues and pull
  requests on the client repository, never here.

Precedent: a media-library request first filed on the client repository was
closed there as misfiled and recreated here as #109, because it described
CMS platform features. That is the standard to follow in both directions.

One exception has occurred: the dashboard redesign was built and proven on
the client installation first and ported back here (PR #118). A port like
that must strip every client-branded component, all client content, and all
client media before it lands, and must name the source commit it came from.
Treat this as recovery-only; the normal direction is product-first.

## Implementation workflow for product issues

1. Implement and test in this repository, against the reference site and its
   neutral content. All normal gates apply.
2. After the change merges, refresh the client installation: produce the
   foundation release artifacts from the new `main` commit, update the
   installation's pin and vendored packages, and run the installation's own
   gates there.
3. Redeploy the installation's private preview so the owner can verify the
   feature against real content on desktop and phone. The owner verifies a
   product feature on the real installation, not on the reference site. A
   feature is complete only after that verification.

Check the current build-order guidance on issue #101 before starting a
dashboard-surface issue; it records which branch to build on.

Client installations are private acceptance environments. Nothing in this
document authorizes npm publication, a GitHub release, a production DNS
change, or a client-domain cutover. Those remain gated by #98 and #101.
