/**
 * The create-flow verification ceremony.
 *
 * A provisioning report is a claim until these checks pass against the client's
 * own account. They prove the four things a scaffolded and deployed
 * installation must be able to do: serve the public reference site, protect
 * `/dash` and its sibling namespaces, complete one attributed publication that
 * is verifiably live, and run with no Humber Foundry runtime authority
 * anywhere in its production configuration.
 */

import { canonicalJson } from "@foundry/application";

import type { CredentialSlot } from "./credential-slots";

export type VerificationStatus =
  | "pass"
  | "fail"
  | "degraded"
  | "not_applicable"
  | "pending_action";

export type VerificationPhase = "candidate" | "post_removal";

export type VerificationCheck = Readonly<{
  checkId: string;
  phase: VerificationPhase;
  status: VerificationStatus;
  observedAt: string;
  owner: string;
  evidenceRef: string;
  code: string | null;
}>;

export type ProbeResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type ProbeFetch = (
  url: string,
  init: Readonly<{
    method: string;
    headers: Readonly<Record<string, string>>;
  }>,
) => Promise<ProbeResponse>;

const commitShaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const contentHashPattern = /^[a-f0-9]{64}$/u;

/** ADR-0005 protects exactly these three path families and their descendants. */
export const protectedPathFamilies = Object.freeze([
  "/dash",
  "/api/foundry-cms",
  "/__foundry/preview",
]);

const protectedProbePaths = Object.freeze([
  "/dash",
  "/dash/settings",
  "/api/foundry-cms",
  "/api/foundry-cms/revisions",
  "/__foundry/preview",
  "/__foundry/preview/workspace/1",
]);

const publicProbePaths = Object.freeze([
  "/",
  "/.well-known/foundry-release.json",
]);

function check(
  checkId: string,
  {
    status,
    observedAt,
    owner,
    evidenceRef,
    code = null,
    phase = "candidate" as VerificationPhase,
  }: {
    status: VerificationStatus;
    observedAt: string;
    owner: string;
    evidenceRef: string;
    code?: string | null;
    phase?: VerificationPhase;
  },
): VerificationCheck {
  return Object.freeze({
    checkId,
    phase,
    status,
    observedAt,
    owner,
    evidenceRef,
    code,
  });
}

/**
 * Builds the pair of results one check reports: one `pass`, or one `fail`
 * carrying the stable code that says which assertion did not hold.
 */
function checkOutcome(
  checkId: string,
  { observedAt, owner, evidenceRef }: {
    observedAt: string;
    owner: string;
    evidenceRef: string;
  },
) {
  return {
    pass: () =>
      check(checkId, { status: "pass", observedAt, owner, evidenceRef }),
    fail: (code: string) =>
      check(checkId, { status: "fail", observedAt, owner, evidenceRef, code }),
  };
}

const accessHeaderPattern = /^cf-access-/u;

/**
 * A challenge only counts when it identifies Access itself.
 *
 * ADR-0005 also requires the application layer to reject every request without
 * a valid assertion, so a bare 401 or 403 is exactly what an installation with
 * *no* Access application in front of it would return. Accepting one would let
 * this check certify the missing gate it exists to prove.
 */
function isAccessChallenge(response: ProbeResponse): boolean {
  if (response.status === 302 || response.status === 303) {
    const location = response.headers.location ?? "";
    return /^https:\/\/[^/]+\.cloudflareaccess\.com\//u.test(location);
  }
  if (response.status !== 401 && response.status !== 403) {
    return false;
  }
  return Object.keys(response.headers).some((header) =>
    accessHeaderPattern.test(header.toLowerCase()),
  );
}

/**
 * The public reference site is only proved live by an uncached release marker
 * that names the exact deployed commit and content hash. A rendered page alone
 * proves nothing about which revision is serving.
 */
export async function verifyPublicReferenceSite({
  canonicalHostname,
  expectedCommitSha,
  expectedContentHash,
  probe,
  observedAt,
  owner = "client-cloudflare-administrator",
}: {
  canonicalHostname: string;
  expectedCommitSha: string;
  expectedContentHash: string;
  probe: ProbeFetch;
  observedAt: string;
  owner?: string;
}): Promise<VerificationCheck> {
  const { pass, fail } = checkOutcome("site.public-reference", {
    observedAt,
    owner,
    evidenceRef: `check:site.public-reference:${canonicalHostname}`,
  });

  if (
    !commitShaPattern.test(expectedCommitSha) ||
    !contentHashPattern.test(expectedContentHash)
  ) {
    return fail("site.expected_release_invalid");
  }

  const marker = await probe(
    `https://${canonicalHostname}/.well-known/foundry-release.json`,
    { method: "GET", headers: { "cache-control": "no-cache" } },
  );
  if (marker.status !== 200) {
    return fail("site.release_marker_unavailable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(marker.body);
  } catch {
    return fail("site.release_marker_unparsable");
  }
  const release = parsed as Record<string, unknown>;
  if (release.commitSha !== expectedCommitSha) {
    return fail("site.release_commit_mismatch");
  }
  if (release.contentHash !== expectedContentHash) {
    return fail("site.release_content_mismatch");
  }

  const home = await probe(`https://${canonicalHostname}/`, {
    method: "GET",
    headers: { "cache-control": "no-cache" },
  });
  // An Access challenge is never a 200, so a non-200 here covers both an outage
  // and a public path that was accidentally placed behind the application.
  if (home.status !== 200) {
    return fail("site.public_page_unavailable");
  }

  return pass();
}

/**
 * Protection is proved by the whole route matrix, not by one redirect. A
 * namespace that is reachable through the origin, a `workers.dev` alias, a
 * version preview or a CORS preflight is not protected.
 */
export async function verifyDashProtected({
  canonicalHostname,
  bypassOrigins,
  probe,
  observedAt,
  owner = "client-zero-trust-administrator",
}: {
  canonicalHostname: string;
  bypassOrigins: ReadonlyArray<string>;
  probe: ProbeFetch;
  observedAt: string;
  owner?: string;
}): Promise<VerificationCheck> {
  const { pass, fail } = checkOutcome("auth.dash-protected", {
    observedAt,
    owner,
    evidenceRef: `check:auth.dash-protected:${canonicalHostname}`,
  });

  for (const path of protectedProbePaths) {
    const response = await probe(`https://${canonicalHostname}${path}`, {
      method: "GET",
      headers: {},
    });
    if (!isAccessChallenge(response)) {
      return fail("auth.protected_path_reachable");
    }
  }

  for (const path of publicProbePaths) {
    const response = await probe(`https://${canonicalHostname}${path}`, {
      method: "GET",
      headers: {},
    });
    if (response.status !== 200) {
      return fail("auth.public_path_unavailable");
    }
  }

  for (const path of protectedProbePaths) {
    const preflight = await probe(`https://${canonicalHostname}${path}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    });
    if (!isAccessChallenge(preflight)) {
      return fail("auth.cors_preflight_bypass");
    }
  }

  for (const origin of bypassOrigins) {
    for (const path of protectedPathFamilies) {
      const response = await probe(`https://${origin}${path}`, {
        method: "GET",
        headers: {},
      });
      // An alias is only proved safe when it challenges through the same Access
      // application or refuses the request outright. Any other success or
      // redirect means something is still answering on that hostname, which is
      // exactly the bypass this check exists to rule out.
      if (!isAccessChallenge(response) && response.status < 400) {
        return fail("auth.alias_bypass_reachable");
      }
    }
  }

  return pass();
}

export type PublicationEvidence = Readonly<{
  commitSha: string;
  forcePushed: boolean;
  committer: Readonly<{ name: string; email: string }>;
  publisherAppSlug: string;
  approvedByRole: string;
  approvedByIsHuman: boolean;
  authoredByAgent: string | null;
  build: Readonly<{ commitSha: string; status: string }>;
  releaseMarker: Readonly<{ commitSha: string; contentHash: string }>;
  revision: Readonly<{ revisionId: string; contentHash: string }>;
}>;

const personalEmailAllowedSuffix = "@users.noreply.github.com";

/**
 * "Live" requires four agreeing facts: one non-force publisher-App commit with
 * truthful attribution, a build that reports that exact commit, a release
 * marker serving that commit, and a content hash equal to the approved
 * revision's. A Git commit alone is never proof.
 */
export function verifyAttributedPublication({
  publication,
  observedAt,
  owner = "client-repository-owner",
}: {
  publication: PublicationEvidence;
  observedAt: string;
  owner?: string;
}): VerificationCheck {
  const { pass, fail } = checkOutcome("publication.attributed-live", {
    observedAt,
    owner,
    evidenceRef: `check:publication.attributed-live:${publication.revision.revisionId}`,
  });

  if (!commitShaPattern.test(publication.commitSha)) {
    return fail("publication.commit_invalid");
  }
  if (publication.forcePushed) {
    return fail("publication.force_push_detected");
  }
  if (publication.committer.name !== `${publication.publisherAppSlug}[bot]`) {
    return fail("publication.attribution_untruthful");
  }
  if (!publication.committer.email.endsWith(personalEmailAllowedSuffix)) {
    return fail("publication.personal_email_recorded");
  }
  if (!publication.approvedByIsHuman) {
    return fail("publication.approval_not_human");
  }
  if (!["owner", "editor"].includes(publication.approvedByRole)) {
    return fail("publication.approval_role_insufficient");
  }
  if (publication.build.status !== "success") {
    return fail("publication.build_not_successful");
  }
  if (publication.build.commitSha !== publication.commitSha) {
    return fail("publication.build_commit_mismatch");
  }
  if (publication.releaseMarker.commitSha !== publication.commitSha) {
    return fail("publication.release_commit_mismatch");
  }
  if (
    !contentHashPattern.test(publication.revision.contentHash) ||
    publication.releaseMarker.contentHash !== publication.revision.contentHash
  ) {
    return fail("publication.release_content_mismatch");
  }

  return pass();
}

export type ProductionConfiguration = Readonly<{
  workerBindings: ReadonlyArray<Readonly<{ name: string; target: string }>>;
  dnsTargets: ReadonlyArray<string>;
  webhookUrls: ReadonlyArray<string>;
  schedulerEndpoints: ReadonlyArray<string>;
  accessIssuer: string;
  buildTokenOwnerPrincipal: string;
  credentialSlots: ReadonlyArray<CredentialSlot>;
}>;

const clientOwnershipPrefix = "client-";

/**
 * Independence is a property of the deployed configuration, not of a promise in
 * a report. Every binding, DNS target, callback, schedule, build identity and
 * credential owner must resolve inside the client's own accounts.
 */
export function verifyNoMaintainerRuntimeAuthority({
  configuration,
  maintainerIdentifiers,
  observedAt,
  owner = "client-account-owner",
}: {
  configuration: ProductionConfiguration;
  maintainerIdentifiers: ReadonlyArray<string>;
  observedAt: string;
  owner?: string;
}): VerificationCheck {
  const { pass, fail } = checkOutcome("independence.no-maintainer-authority", {
    observedAt,
    owner,
    evidenceRef: "check:independence.no-maintainer-authority",
  });

  const normalizedIdentifiers = maintainerIdentifiers
    .map((identifier) => identifier.trim().toLowerCase())
    .filter((identifier) => identifier.length > 0);
  if (normalizedIdentifiers.length === 0) {
    return fail("independence.maintainer_identifiers_undeclared");
  }

  const serialized = canonicalJson(configuration).toLowerCase();
  for (const identifier of normalizedIdentifiers) {
    if (serialized.includes(identifier)) {
      return fail("independence.maintainer_reference_present");
    }
  }

  if (
    !configuration.buildTokenOwnerPrincipal.startsWith(clientOwnershipPrefix)
  ) {
    return fail("independence.build_token_not_client_owned");
  }

  for (const slot of configuration.credentialSlots) {
    if (!slot.ownershipPrincipal.startsWith(clientOwnershipPrefix)) {
      return fail("independence.credential_owner_not_client");
    }
    if (slot.health !== "verified" && slot.health !== "not_required") {
      return fail("independence.credential_health_unproved");
    }
  }

  return pass();
}

export type CreateVerificationReport = Readonly<{
  status: "passed" | "failed";
  checks: ReadonlyArray<VerificationCheck>;
}>;

/**
 * The create profile is fail-closed: every check must be `pass`. Nothing in
 * this profile may be `degraded` or `not_applicable`, because each check is a
 * fixed v1 capability.
 */
export async function verifyCreatedInstallation(input: {
  canonicalHostname: string;
  expectedCommitSha: string;
  expectedContentHash: string;
  bypassOrigins: ReadonlyArray<string>;
  probe: ProbeFetch;
  publication: PublicationEvidence;
  configuration: ProductionConfiguration;
  maintainerIdentifiers: ReadonlyArray<string>;
  observedAt: string;
}): Promise<CreateVerificationReport> {
  const checks = [
    await verifyPublicReferenceSite({
      canonicalHostname: input.canonicalHostname,
      expectedCommitSha: input.expectedCommitSha,
      expectedContentHash: input.expectedContentHash,
      probe: input.probe,
      observedAt: input.observedAt,
    }),
    await verifyDashProtected({
      canonicalHostname: input.canonicalHostname,
      bypassOrigins: input.bypassOrigins,
      probe: input.probe,
      observedAt: input.observedAt,
    }),
    verifyAttributedPublication({
      publication: input.publication,
      observedAt: input.observedAt,
    }),
    verifyNoMaintainerRuntimeAuthority({
      configuration: input.configuration,
      maintainerIdentifiers: input.maintainerIdentifiers,
      observedAt: input.observedAt,
    }),
  ];

  return Object.freeze({
    status: checks.every((entry) => entry.status === "pass")
      ? ("passed" as const)
      : ("failed" as const),
    checks: Object.freeze(checks),
  });
}
