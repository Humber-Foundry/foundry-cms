import { afterEach, describe, expect, it, vi } from "vitest";

const formCapture = vi.hoisted(() => ({ accepted: undefined as any }));

vi.mock("server-only", () => ({}));
vi.mock("../foundry/site-definition", async () => {
  const { alternateSiteDefinition } = await import(
    "./test-support/alternate-site-definition"
  );
  const { isSiteDefinition } = await import(
    "@humber-foundry/site-definition"
  );
  return {
    installedSiteDefinition: alternateSiteDefinition,
    isInstalledSiteDefinition: isSiteDefinition,
  };
});
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: {
      FOUNDRY_DB: {},
      FOUNDRY_CANONICAL_ORIGIN: "https://alternate.example",
      FOUNDRY_TURNSTILE_SECRET: "turnstile-secret",
      FOUNDRY_FORM_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
    },
  })),
}));
vi.mock("./d1-public-form-store", () => ({
  createD1PublicFormAcceptanceStore: () => ({
    async findReceipt() {
      return null;
    },
    async accept(value: unknown) {
      formCapture.accepted = value;
      return {
        outcome: "accepted" as const,
        receiptId: "receipt_01J00000000000000000000102",
      };
    },
  }),
}));
vi.mock("./cloudflare-turnstile", () => ({
  createCloudflareTurnstileVerifier: () => ({
    async verify() {
      return {
        success: true,
        hostname: "alternate.example",
        action: "contact",
      };
    },
  }),
}));

import {
  createContentActorId,
  createContentWorkspaceId,
} from "@humber-foundry/application";
import {
  contentWorkspaceIdForActor,
  loadContentRevisionApplication,
} from "./content-revision-runtime";
import { createProductionMcpRuntime } from "./mcp-production-runtime";
import { acceptPublicFormSubmission } from "./public-form-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  formCapture.accepted = undefined;
});

describe("installation-owned runtime seam", () => {
  it("creates a revision workspace from the installed alternate definition", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const actorId = createContentActorId("membership-runtime-alternate");
    const workspaceId = await contentWorkspaceIdForActor(actorId);
    expect(workspaceId).not.toBe(
      createContentWorkspaceId("workspace_reference_runtime"),
    );

    const application = await loadContentRevisionApplication(
      workspaceId,
      actorId,
    );
    const created = await application.commands.create({
      actorId,
      workspaceId,
      idempotencyKey: "alternate-runtime-workspace-create-0001",
    });
    expect(created.definition.site).toMatchObject({
      id: "site_alternate_installation",
      name: "Alternate installation",
    });
    expect(created.definition.blog.posts[0]?.slug).toBe(
      "alternate-installation-post",
    );
  });

  it("scopes the public-form runtime to the installed alternate site", async () => {
    await acceptPublicFormSubmission({
      formId: "contact",
      schemaVersion: "1.0.0",
      submissionId: "10000000-0000-4000-8000-000000000102",
      fields: { name: "Alternate", message: "Runtime seam" },
      turnstileToken: "alternate-token",
      origin: "https://alternate.example",
      bodySize: 128,
      abuseKey: "alternate-abuse-key",
      honeypot: "",
      startedAt: "2026-08-09T20:00:00.000Z",
    });
    expect(formCapture.accepted.identity.siteId).toBe(
      "site_alternate_installation",
    );
  });

  it("publishes the installed alternate identity through MCP metadata", async () => {
    const runtime = createProductionMcpRuntime({
      FOUNDRY_DB: {} as any,
      FOUNDRY_CANONICAL_ORIGIN: "https://alternate.example",
      FOUNDRY_MCP_OAUTH_SIGNING_KEY:
        "alternate-mcp-signing-secret-at-least-32-bytes",
      FOUNDRY_MCP_CLIENTS: JSON.stringify({
        "https://client.alternate.example/metadata.json": {
          name: "Alternate client",
          redirectUris: ["https://client.alternate.example/callback"],
        },
      }),
    });
    const response = await runtime.fetch(
      new Request(
        "https://alternate.example/.well-known/oauth-protected-resource/api/foundry-mcp",
      ),
    );
    await expect(response.json()).resolves.toMatchObject({
      resource_name: "Alternate installation — Foundry CMS",
    });
  });
});
