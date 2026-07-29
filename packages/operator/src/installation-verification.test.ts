import { describe, expect, it, vi } from "vitest";

import { createCredentialSlot } from "./credential-slots";
import {
  protectedPathFamilies,
  verifyAttributedPublication,
  verifyCreatedInstallation,
  verifyDashProtected,
  verifyNoMaintainerRuntimeAuthority,
  verifyPublicReferenceSite,
  type ProbeResponse,
  type ProductionConfiguration,
  type PublicationEvidence,
} from "./installation-verification";

const canonicalHostname = "acme-marine.example";
const commitSha = "c6be19d3f0a1b2c3d4e5f60718293a4b5c6d7e8f";
const contentHash = "a".repeat(64);
const observedAt = "2026-07-27T00:10:00.000Z";

function response(overrides: Partial<ProbeResponse> = {}): ProbeResponse {
  return { status: 200, headers: {}, body: "", ...overrides };
}

const accessChallenge = response({
  status: 302,
  headers: { location: "https://acme.cloudflareaccess.com/cdn-cgi/access/login" },
});

const releaseMarker = response({
  body: JSON.stringify({
    commitSha,
    contentHash,
    schemaVersion: "1.0.0",
  }),
});

function createProbe(routes: Record<string, ProbeResponse> = {}) {
  return vi.fn(async (url: string, init: { method: string }) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.host}${parsed.pathname}`;
    if (routes[key] !== undefined) {
      return routes[key];
    }
    if (parsed.host !== canonicalHostname) {
      return response({ status: 404 });
    }
    if (parsed.pathname === "/.well-known/foundry-release.json") {
      return releaseMarker;
    }
    if (parsed.pathname === "/") {
      return response({ status: 200, body: "<html>Acme Marine</html>" });
    }
    if (
      protectedPathFamilies.some((family) =>
        parsed.pathname.startsWith(family),
      )
    ) {
      return accessChallenge;
    }
    return response({ status: 404 });
  });
}

describe("public reference site", () => {
  it("passes when the uncached release marker names the deployed revision", async () => {
    const probe = createProbe();
    const result = await verifyPublicReferenceSite({
      canonicalHostname,
      expectedCommitSha: commitSha,
      expectedContentHash: contentHash,
      probe,
      observedAt,
    });

    expect(result.status).toBe("pass");
    expect(result.checkId).toBe("site.public-reference");
    expect(probe.mock.calls[0]?.[1]).toMatchObject({
      headers: { "cache-control": "no-cache" },
    });
  });

  it("fails when the release marker names another commit", async () => {
    const result = await verifyPublicReferenceSite({
      canonicalHostname,
      expectedCommitSha: "b".repeat(40),
      expectedContentHash: contentHash,
      probe: createProbe(),
      observedAt,
    });

    expect(result.status).toBe("fail");
    expect(result.code).toBe("site.release_commit_mismatch");
  });

  it("fails when the release marker names another content hash", async () => {
    const result = await verifyPublicReferenceSite({
      canonicalHostname,
      expectedCommitSha: commitSha,
      expectedContentHash: "c".repeat(64),
      probe: createProbe(),
      observedAt,
    });

    expect(result.code).toBe("site.release_content_mismatch");
  });

  it("fails when the release marker is unavailable or unparsable", async () => {
    expect(
      (
        await verifyPublicReferenceSite({
          canonicalHostname,
          expectedCommitSha: commitSha,
          expectedContentHash: contentHash,
          probe: createProbe({
            [`GET ${canonicalHostname}/.well-known/foundry-release.json`]:
              response({ status: 503 }),
          }),
          observedAt,
        })
      ).code,
    ).toBe("site.release_marker_unavailable");

    expect(
      (
        await verifyPublicReferenceSite({
          canonicalHostname,
          expectedCommitSha: commitSha,
          expectedContentHash: contentHash,
          probe: createProbe({
            [`GET ${canonicalHostname}/.well-known/foundry-release.json`]:
              response({ body: "not json" }),
          }),
          observedAt,
        })
      ).code,
    ).toBe("site.release_marker_unparsable");
  });

  it("fails when the public page itself is behind Access", async () => {
    const result = await verifyPublicReferenceSite({
      canonicalHostname,
      expectedCommitSha: commitSha,
      expectedContentHash: contentHash,
      probe: createProbe({ [`GET ${canonicalHostname}/`]: accessChallenge }),
      observedAt,
    });

    expect(result.code).toBe("site.public_page_unavailable");
  });

  it("refuses a malformed expected release", async () => {
    expect(
      (
        await verifyPublicReferenceSite({
          canonicalHostname,
          expectedCommitSha: "HEAD",
          expectedContentHash: contentHash,
          probe: createProbe(),
          observedAt,
        })
      ).code,
    ).toBe("site.expected_release_invalid");
  });
});

describe("protected dashboard namespaces", () => {
  it("passes when every protected family challenges and public paths serve", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: ["acme.workers.dev", "preview-1.acme.workers.dev"],
      probe: createProbe(),
      observedAt,
    });

    expect(result.status).toBe("pass");
  });

  it("fails when any protected path answers with the application", async () => {
    for (const path of ["/dash", "/api/foundry-cms", "/__foundry/preview"]) {
      const result = await verifyDashProtected({
        canonicalHostname,
        bypassOrigins: [],
        probe: createProbe({
          [`GET ${canonicalHostname}${path}`]: response({ status: 200 }),
        }),
        observedAt,
      });

      expect(result.code).toBe("auth.protected_path_reachable");
    }
  });

  it("fails when a descendant path is reachable even though its parent is not", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: [],
      probe: createProbe({
        [`GET ${canonicalHostname}/dash/settings`]: response({ status: 200 }),
      }),
      observedAt,
    });

    expect(result.code).toBe("auth.protected_path_reachable");
  });

  it("fails when a CORS preflight bypasses Access", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: [],
      probe: createProbe({
        [`OPTIONS ${canonicalHostname}/dash`]: response({
          status: 204,
          headers: { "access-control-allow-origin": "*" },
        }),
      }),
      observedAt,
    });

    expect(result.code).toBe("auth.cors_preflight_bypass");
  });

  it("fails when an alias answers a protected namespace with any success", async () => {
    for (const aliasResponse of [
      response({ status: 200 }),
      response({ status: 204 }),
      response({
        status: 302,
        headers: { location: "https://acme.workers.dev/login" },
      }),
    ]) {
      const result = await verifyDashProtected({
        canonicalHostname,
        bypassOrigins: ["acme.workers.dev"],
        probe: createProbe({ "GET acme.workers.dev/dash": aliasResponse }),
        observedAt,
      });

      expect(result.code).toBe("auth.alias_bypass_reachable");
    }
  });

  it("accepts an alias that is refused outright or challenged by the same application", async () => {
    for (const aliasResponse of [
      response({ status: 404 }),
      response({ status: 530 }),
      accessChallenge,
    ]) {
      const result = await verifyDashProtected({
        canonicalHostname,
        bypassOrigins: ["acme.workers.dev"],
        probe: createProbe({
          "GET acme.workers.dev/dash": aliasResponse,
          "GET acme.workers.dev/api/foundry-cms": aliasResponse,
          "GET acme.workers.dev/__foundry/preview": aliasResponse,
        }),
        observedAt,
      });

      expect(result.status).toBe("pass");
    }
  });

  it("fails when a workers.dev alias still serves a protected namespace", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: ["acme.workers.dev"],
      probe: createProbe({
        "GET acme.workers.dev/dash": response({ status: 200 }),
      }),
      observedAt,
    });

    expect(result.code).toBe("auth.alias_bypass_reachable");
  });

  it("fails when a public path stops serving", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: [],
      probe: createProbe({
        [`GET ${canonicalHostname}/`]: response({ status: 500 }),
      }),
      observedAt,
    });

    expect(result.code).toBe("auth.public_path_unavailable");
  });

  it("rejects a bare 401 or 403 that does not identify Access", async () => {
    // An installation with no Access application still fails closed at the
    // application layer, so a bare 401 proves nothing about the outer gate.
    for (const bare of [response({ status: 401 }), response({ status: 403 })]) {
      const result = await verifyDashProtected({
        canonicalHostname,
        bypassOrigins: [],
        probe: createProbe({ [`GET ${canonicalHostname}/dash`]: bare }),
        observedAt,
      });

      expect(result.code).toBe("auth.protected_path_reachable");
    }
  });

  it("accepts a 401 or 403 that carries an Access header", async () => {
    const result = await verifyDashProtected({
      canonicalHostname,
      bypassOrigins: [],
      probe: createProbe(
        Object.fromEntries(
          [
            "/dash",
            "/dash/settings",
            "/api/foundry-cms",
            "/api/foundry-cms/revisions",
            "/__foundry/preview",
            "/__foundry/preview/workspace/1",
          ].flatMap((path) => [
            [
              `GET ${canonicalHostname}${path}`,
              response({
                status: 401,
                headers: { "cf-access-aud": "aud-1" },
              }),
            ],
            [
              `OPTIONS ${canonicalHostname}${path}`,
              response({
                status: 403,
                headers: { "cf-access-domain": "acme.cloudflareaccess.com" },
              }),
            ],
          ]),
        ),
      ),
      observedAt,
    });

    expect(result.status).toBe("pass");
  });
});

function publication(
  overrides: Partial<PublicationEvidence> = {},
): PublicationEvidence {
  return {
    commitSha,
    forcePushed: false,
    committer: {
      name: "acme-foundry-publisher[bot]",
      email: "1234567+acme-foundry-publisher[bot]@users.noreply.github.com",
    },
    publisherAppSlug: "acme-foundry-publisher",
    approvedByRole: "owner",
    approvedByIsHuman: true,
    authoredByAgent: null,
    build: { commitSha, status: "success" },
    releaseMarker: { commitSha, contentHash },
    revision: { revisionId: "rev-1", contentHash },
    ...overrides,
  };
}

describe("attributed verified-live publication", () => {
  it("passes when commit, build, marker and revision all agree", () => {
    expect(
      verifyAttributedPublication({ publication: publication(), observedAt })
        .status,
    ).toBe("pass");
  });

  it("fails a force-pushed publication", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({ forcePushed: true }),
        observedAt,
      }).code,
    ).toBe("publication.force_push_detected");
  });

  it("fails a commit attributed to anything but the publisher App", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({
          committer: {
            name: "Acme Operator",
            email: "operator@users.noreply.github.com",
          },
        }),
        observedAt,
      }).code,
    ).toBe("publication.attribution_untruthful");
  });

  it("fails a commit recording a personal email address", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({
          committer: {
            name: "acme-foundry-publisher[bot]",
            email: "owner@acme-marine.example",
          },
        }),
        observedAt,
      }).code,
    ).toBe("publication.personal_email_recorded");
  });

  it("fails when the approval was not a human CMS role", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({ approvedByIsHuman: false }),
        observedAt,
      }).code,
    ).toBe("publication.approval_not_human");
    expect(
      verifyAttributedPublication({
        publication: publication({ approvedByRole: "mcp_agent" }),
        observedAt,
      }).code,
    ).toBe("publication.approval_role_insufficient");
  });

  it("fails when the build did not report this exact commit", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({
          build: { commitSha: "d".repeat(40), status: "success" },
        }),
        observedAt,
      }).code,
    ).toBe("publication.build_commit_mismatch");
    expect(
      verifyAttributedPublication({
        publication: publication({
          build: { commitSha, status: "failure" },
        }),
        observedAt,
      }).code,
    ).toBe("publication.build_not_successful");
  });

  it("fails when the live release marker does not match the approved revision", () => {
    expect(
      verifyAttributedPublication({
        publication: publication({
          releaseMarker: { commitSha: "d".repeat(40), contentHash },
        }),
        observedAt,
      }).code,
    ).toBe("publication.release_commit_mismatch");
    expect(
      verifyAttributedPublication({
        publication: publication({
          releaseMarker: { commitSha, contentHash: "e".repeat(64) },
        }),
        observedAt,
      }).code,
    ).toBe("publication.release_content_mismatch");
  });
});

function clientSlot(overrides: Record<string, unknown> = {}) {
  const slot = createCredentialSlot({
    slotId: "turnstile_secret",
    provider: "cloudflare",
    ownershipPrincipal: "client-cloudflare-administrator",
    intakeSurface: "provider_creation_response",
    minimumAuthority: "one widget verification secret",
    rotationProcedure: "rotate widget secret and repeat synthetic validation",
    healthCheckId: "forms.turnstile-validation",
  });
  return Object.freeze({ ...slot, health: "verified", ...overrides });
}

function configuration(
  overrides: Partial<ProductionConfiguration> = {},
): ProductionConfiguration {
  return {
    workerBindings: [
      { name: "DB", target: "acme-kmnpqrstuvwxyzab" },
      { name: "MEDIA", target: "acme-kmnpqrstuvwxyzab-media" },
    ],
    dnsTargets: [canonicalHostname],
    webhookUrls: [`https://${canonicalHostname}/api/providers/brevo`],
    schedulerEndpoints: [`https://${canonicalHostname}/__scheduled`],
    accessIssuer: "https://acme.cloudflareaccess.com",
    buildTokenOwnerPrincipal: "client-build-token-owner",
    credentialSlots: [clientSlot()],
    ...overrides,
  } as ProductionConfiguration;
}

describe("independence from maintainer runtime authority", () => {
  const maintainerIdentifiers = [
    "humberfoundry.com",
    "foundry-cms.workers.dev",
    "humber-foundry",
  ];

  it("passes when nothing in production references the maintainer", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration(),
        maintainerIdentifiers,
        observedAt,
      }).status,
    ).toBe("pass");
  });

  it("fails when a webhook still calls a maintainer host", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          webhookUrls: ["https://hooks.humberfoundry.com/brevo"],
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.maintainer_reference_present");
  });

  it("fails when a scheduler or DNS target points at maintainer infrastructure", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          schedulerEndpoints: ["https://foundry-cms.workers.dev/__scheduled"],
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.maintainer_reference_present");
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          dnsTargets: ["foundry-cms.workers.dev"],
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.maintainer_reference_present");
  });

  it("fails when the build token is not client owned", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          buildTokenOwnerPrincipal: "operator-personal-token",
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.build_token_not_client_owned");
  });

  it("fails when a credential slot is not owned by the client", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          credentialSlots: [
            clientSlot({ ownershipPrincipal: "foundry-maintainer" }),
          ],
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.credential_owner_not_client");
  });

  it("fails when a credential slot has not proved its health", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration({
          credentialSlots: [clientSlot({ health: "unverified" })],
        }),
        maintainerIdentifiers,
        observedAt,
      }).code,
    ).toBe("independence.credential_health_unproved");
  });

  it("refuses to pass when no maintainer identifier was declared", () => {
    expect(
      verifyNoMaintainerRuntimeAuthority({
        configuration: configuration(),
        maintainerIdentifiers: [],
        observedAt,
      }).code,
    ).toBe("independence.maintainer_identifiers_undeclared");
  });
});

describe("create verification profile", () => {
  const input = {
    canonicalHostname,
    expectedCommitSha: commitSha,
    expectedContentHash: contentHash,
    bypassOrigins: ["acme.workers.dev"],
    publication: publication(),
    configuration: configuration(),
    maintainerIdentifiers: ["humberfoundry.com", "humber-foundry"],
    observedAt,
  };

  it("passes only when all four capability checks pass", async () => {
    const report = await verifyCreatedInstallation({
      ...input,
      probe: createProbe(),
    });

    expect(report.status).toBe("passed");
    expect(report.checks.map((entry) => entry.checkId)).toEqual([
      "site.public-reference",
      "auth.dash-protected",
      "publication.attributed-live",
      "independence.no-maintainer-authority",
    ]);
    expect(report.checks.every((entry) => entry.phase === "candidate")).toBe(
      true,
    );
  });

  it("fails the whole profile when one check fails", async () => {
    const report = await verifyCreatedInstallation({
      ...input,
      probe: createProbe({
        [`GET ${canonicalHostname}/dash`]: response({ status: 200 }),
      }),
    });

    expect(report.status).toBe("failed");
    expect(
      report.checks.filter((entry) => entry.status === "fail"),
    ).toHaveLength(1);
  });

  it("never reports a create-profile check as degraded or not applicable", async () => {
    const report = await verifyCreatedInstallation({
      ...input,
      probe: createProbe({
        [`GET ${canonicalHostname}/.well-known/foundry-release.json`]:
          response({ status: 503 }),
      }),
    });

    for (const entry of report.checks) {
      expect(["pass", "fail"]).toContain(entry.status);
    }
  });
});
