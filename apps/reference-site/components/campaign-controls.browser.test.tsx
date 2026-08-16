import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type {
  Campaign,
  CampaignRevision,
} from "@humber-foundry/application";
import {
  createSiteId,
  type RichTextDocument,
} from "@humber-foundry/site-definition";

import { CampaignControls } from "./campaign-controls";

const richEmailContent: RichTextDocument = Object.freeze({
  version: "1.0.0",
  type: "document",
  children: Object.freeze([
    Object.freeze({
      type: "heading",
      level: 2,
      children: Object.freeze([
        Object.freeze({
          type: "text",
          text: "News",
          marks: ["bold"] as const,
        }),
      ]),
    }),
  ]),
});

describe("campaign controls browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  it("preserves rich email content when editing another campaign field", async () => {
    const campaign = {
      id: "20000000-0000-4000-8000-000000000001",
      siteId: createSiteId("site_reference"),
      lifecycleState: "draft",
      currentRevisionId: "30000000-0000-4000-8000-000000000001",
      version: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as Campaign;
    const revision = {
      id: campaign.currentRevisionId,
      siteId: campaign.siteId,
      campaignId: campaign.id,
      revisionNumber: 1,
      provenance: { kind: "standalone" },
      subject: "Original subject",
      previewText: "Preview",
      callToAction: { label: "Read", href: "https://example.org" },
      emailContent: richEmailContent,
      senderIdentityId: "sender-primary",
      complianceFooter: {
        version: "v1",
        content: "Compliance",
        unsubscribePlaceholder:
          "https://example.test/unsubscribe?token={{foundry.unsubscribe.token}}",
      },
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
      schemaVersion: "1.4.0",
      rendererVersion: "1".repeat(40),
      createdAt: campaign.createdAt,
      createdByActorId: "membership-editor",
    } as CampaignRevision;
    let submitted: unknown;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return Response.json({
          campaign: { ...campaign, version: 2 },
          revision: { ...revision, revisionNumber: 2 },
        });
      }
      return Response.json({
        campaigns: [{ campaign: { ...campaign, version: 2 }, revision }],
      });
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(CampaignControls, {
          csrfToken: "csrf",
          postSources: [],
          initialCampaigns: [{ campaign, revision }],
        }),
      );
    });

    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    const editSubject = Array.from(
      host.querySelectorAll<HTMLInputElement>('input[name="subject"]'),
    ).find(({ value }) => value === "Original subject");
    expect(editSubject).toBeDefined();
    await userEvent.fill(
      editSubject!,
      "Updated subject",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Save changes" }),
    );

    expect(submitted).toMatchObject({
      action: "edit",
      input: {
        subject: "Updated subject",
        emailContent: richEmailContent,
      },
    });
  });
});
