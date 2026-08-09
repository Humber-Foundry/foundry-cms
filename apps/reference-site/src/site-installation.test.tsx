import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SiteRenderer } from "../components/site-renderer";
import { verifiedPublicBlogPostIds } from "../components/dashboard-shell";
import { findPublicBlogPost } from "./blog-post-page";
import { createSiteInstallation } from "../foundry/site-definition.server";
import { alternateSiteDefinition } from "./test-support/alternate-site-definition";
import {
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  createMcpReadApplication,
  createPublicFormApplication,
  createPublicFormId,
  createPublicFormReceiptId,
  type McpConnectionPrincipal,
  type PublicFormAcceptance,
} from "@humber-foundry/application";

describe("installation-owned Site Definition", () => {
  it("binds public rendering and Blog lookup to a non-reference installation", async () => {
    const installation = createSiteInstallation(alternateSiteDefinition);
    const published = await installation.application.queries.getPublishedSite();

    expect(installation.siteId).toBe("site_alternate_installation");
    expect(published).toBe(alternateSiteDefinition);
    expect(renderToStaticMarkup(<SiteRenderer definition={published} />)).toContain(
      "Alternate installation",
    );
    expect(findPublicBlogPost(published, "alternate-installation-post")?.id).toBe(
      "10000000-0000-4000-8000-000000000102",
    );
    expect(verifiedPublicBlogPostIds(published)).toEqual([
      "10000000-0000-4000-8000-000000000102",
    ]);
  });

  it("binds workspace creation, forms, and MCP reads to the same alternate site identity", async () => {
    const installation = createSiteInstallation(alternateSiteDefinition);
    const actorId = createContentActorId("membership-alternate-owner");
    const workspaceId = createContentWorkspaceId("workspace_alternate");
    const revisions = createContentRevisionApplication({
      siteDefinition: installation.definition,
      store: createInMemoryContentRevisionStore(),
      workspaceId,
      actorId,
      rendererVersion: "renderer-alternate",
      productionBase: "published-alternate",
    });
    const created = await revisions.commands.create({
      actorId,
      workspaceId,
      idempotencyKey: "alternate-workspace-create-0001",
    });
    expect(created.definition.site.id).toBe(installation.siteId);
    expect(created.definition.blog.posts[0]?.title).toBe(
      "Alternate installation post",
    );

    let accepted: PublicFormAcceptance | undefined;
    const forms = createPublicFormApplication({
      siteId: installation.siteId,
      definitions: [
        {
          id: createPublicFormId("contact"),
          schemaVersion: "1.0.0",
          allowedOrigin: "https://alternate.example",
          turnstileHostname: "alternate.example",
          turnstileAction: "contact",
          fields: [{ id: "message", required: true, maximumLength: 200 }],
        },
      ],
      store: {
        async findReceipt() {
          return null;
        },
        async accept(value) {
          accepted = value;
          return {
            outcome: "accepted" as const,
            receiptId: createPublicFormReceiptId(
              "receipt_01J00000000000000000000102",
            ),
          };
        },
      },
      rateLimiter: { async allow() { return true; } },
      turnstile: {
        async verify() {
          return {
            success: true,
            hostname: "alternate.example",
            action: "contact",
          };
        },
      },
      clock: () => new Date("2026-08-09T20:00:00.000Z"),
      createId: (kind) => `${kind}_01J00000000000000000000102`,
      hash: async () => "alternate-request-hash",
    });
    await forms.commands.accept({
      formId: "contact",
      schemaVersion: "1.0.0",
      submissionId: "10000000-0000-4000-8000-000000000102",
      fields: { message: "Alternate site form" },
      turnstileToken: "alternate-browser-token",
      origin: "https://alternate.example",
      bodySize: 128,
      abuseKey: "alternate-abuse-key",
      honeypot: "",
      startedAt: "2026-08-09T19:59:55.000Z",
    });
    expect(accepted?.identity.siteId).toBe(installation.siteId);

    const principal: McpConnectionPrincipal = {
      connectionId: "connection-alternate",
      actorId: "actor-alternate",
      clientId: "https://agent.alternate.example/metadata.json",
      siteId: installation.siteId,
      scopes: ["site.read"],
    };
    const mcp = createMcpReadApplication({
      site: installation.application,
      siteMetadata: {
        canonicalUrl: "https://alternate.example",
        locale: "en-CA",
        timeZone: "America/Vancouver",
        async getLiveRelease() { return null; },
      },
      connections: {
        async findCurrentConnection() {
          return { ...principal, status: "active" as const };
        },
        async recordInvocation() {},
      },
      cursors: {
        async encode() { return "alternate-cursor"; },
        async decode() { throw new Error("unused"); },
      },
      createInvocationId: () => "invocation-alternate",
      now: () => "2026-08-09T20:00:00.000Z",
    });
    await expect(mcp.getSite(principal)).resolves.toMatchObject({
      result: {
        siteId: "site_alternate_installation",
        displayName: "Alternate installation",
      },
    });
  });
});
