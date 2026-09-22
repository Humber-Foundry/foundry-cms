import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { Campaign, CampaignRevision } from "@humber-foundry/application";
import {
  createSiteId,
  type RichTextDocument,
} from "@humber-foundry/site-definition";

const pushed: Array<string> = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      pushed.push(href);
    },
    refresh: () => undefined,
  }),
}));

import { CampaignList } from "./campaign-list";

const richEmailContent: RichTextDocument = Object.freeze({
  version: "1.0.0",
  type: "document",
  children: Object.freeze([
    Object.freeze({
      type: "heading",
      level: 2,
      children: Object.freeze([
        Object.freeze({ type: "text", text: "News", marks: ["bold"] as const }),
      ]),
    }),
  ]),
});

const campaign = {
  id: "20000000-0000-4000-8000-000000000002",
  siteId: createSiteId("site_reference"),
  lifecycleState: "draft",
  currentRevisionId: "30000000-0000-4000-8000-000000000002",
  version: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T17:30:00.000Z",
} as Campaign;

const revision = {
  id: campaign.currentRevisionId,
  siteId: campaign.siteId,
  campaignId: campaign.id,
  revisionNumber: 1,
  provenance: { kind: "standalone" },
  subject: "September news",
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
  audienceDefinition: { id: "canonical-consent-and-suppression", version: 1 },
  schemaVersion: "1.7.0",
  rendererVersion: "1".repeat(40),
  createdAt: campaign.createdAt,
  createdByActorId: "membership-owner",
} as CampaignRevision;

describe("the campaign list, browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    root = undefined;
    pushed.length = 0;
    document.body.replaceChildren();
  });

  /**
   * One fake server for the list. It answers the readiness read and the list
   * read, and records every command.
   */
  function fakeNewsletterServer(
    options: {
      senderDetailsState?: string;
      scheduleRequests?: ReadonlyArray<Record<string, unknown>>;
    } = {},
  ) {
    const commands: Array<Record<string, unknown>> = [];
    const state = {
      scheduleRequests: options.scheduleRequests ?? [],
    };
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          const command = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          commands.push(command);
          if (command.action === "decline_schedule_request") {
            state.scheduleRequests = [];
            return Response.json({ id: command.proposalId });
          }
          if (command.action === "create_from_post") {
            return Response.json({ campaign, revision });
          }
          return Response.json({});
        }
        if (url.includes("readiness=delivery")) {
          const senderDetailsState = options.senderDetailsState ?? "connected";
          return Response.json({
            delivery: {
              state: "connected",
              missingSettings: [],
              providerHealth: null,
              setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
            },
            senderDetails: {
              state: senderDetailsState,
              missingSettings:
                senderDetailsState === "not_configured"
                  ? [
                      "FOUNDRY_CAMPAIGN_LEGAL_NAME",
                      "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
                    ]
                  : [],
              setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
            },
          });
        }
        return Response.json({
          campaigns: [{ campaign, revision }],
          scheduleRequests: state.scheduleRequests,
        });
      },
    );
    return { commands, state };
  }

  function mount(
    campaigns: ReadonlyArray<{ campaign: Campaign; revision: CampaignRevision }>,
    scheduleRequests: ReadonlyArray<{
      proposalId: string;
      campaignId: string;
      agentName: string;
      localDateTime: string;
      ianaTimeZone: string;
    }> = [],
    postSources: ReadonlyArray<{
      post: { id: string; title: string };
      artifact: { postRevisionId: string };
    }> = [],
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(CampaignList, {
          csrfToken: "csrf",
          workspace: "workspace_000000000000000000000001",
          initialCampaigns: campaigns,
          initialScheduleRequests: scheduleRequests,
          // The post sources only need an id, a title and a revision id here.
          postSources: postSources as never,
        }),
      );
    });
    return host;
  }

  const buttonNamed = (host: HTMLElement, name: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === name,
    );

  it("opens on the list with an empty state and a way to write the first email", async () => {
    fakeNewsletterServer();
    const host = mount([]);

    // The writing box never opens by itself. #237: a site with no emails used
    // to land straight in it, so the owner never saw the list at all.
    expect(host.querySelector("form.composer")).toBeNull();
    expect(host.querySelector(".empty-state")).not.toBeNull();
    expect(host.textContent).toContain("No emails yet");
    expect(host.textContent).toContain("Write your first email");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "New email")!.disabled).toBe(false),
    );
    await userEvent.click(buttonNamed(host, "New email")!);
    expect(pushed).toEqual([
      "/dash/campaigns/new?workspace=workspace_000000000000000000000001",
    ]);
  });

  it("shows one row per email, with its state, its date and the way in", () => {
    fakeNewsletterServer();
    const host = mount([{ campaign, revision }]);

    const row = host.querySelector(".dash-row");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("September news");
    expect(row!.textContent).toContain("Draft");
    // The date the row shows is when the draft was last changed.
    expect(row!.textContent).toContain("2 Sept 2026");
    // The whole row opens that email's own screen.
    const open = row!.querySelector<HTMLAnchorElement>("a.dash-row-link");
    expect(open!.getAttribute("href")).toBe(
      `/dash/campaigns/${campaign.id}?workspace=workspace_000000000000000000000001`,
    );
  });

  it("shows an app's send-time request and lets a person decline it", async () => {
    const request = {
      proposalId: "schedule_request_1",
      campaignId: campaign.id,
      agentName: "client.example",
      localDateTime: "2026-09-20T10:00:00",
      ianaTimeZone: "America/Vancouver",
    };
    const server = fakeNewsletterServer({ scheduleRequests: [request] });
    const host = mount([{ campaign, revision }], [request]);

    // The owner reads who asked and when, in plain words.
    expect(host.textContent).toContain("client.example asked to send this at");
    // Declining is a person's step, and it is the only answer offered here;
    // sending stays behind the sending steps on the email's own screen.
    await userEvent.click(
      page.getByRole("button", { name: "Actions for September news" }),
    );
    const decline = buttonNamed(host, "Decline the app's send request");
    expect(decline).toBeDefined();
    await userEvent.click(decline!);

    await vi.waitFor(() =>
      expect(
        server.commands.some(
          ({ action }) => action === "decline_schedule_request",
        ),
      ).toBe(true),
    );
    expect(server.commands).toContainEqual({
      action: "decline_schedule_request",
      proposalId: "schedule_request_1",
    });
    await vi.waitFor(() =>
      expect(host.textContent).not.toContain(
        "client.example asked to send this at",
      ),
    );
  });

  it("opens the new email's own screen after it is made from a blog post", async () => {
    const server = fakeNewsletterServer();
    const host = mount(
      [],
      [],
      [{ post: { id: "post_one", title: "Harbour news" }, artifact: { postRevisionId: "revision-1" } }],
    );

    await userEvent.click(
      page.getByRole("button", { name: "Create email from post" }),
    );
    await vi.waitFor(() =>
      expect(server.commands).toContainEqual({
        action: "create_from_post",
        sourcePostRevisionId: "revision-1",
      }),
    );
    await vi.waitFor(() =>
      expect(pushed).toEqual([
        `/dash/campaigns/${campaign.id}?workspace=workspace_000000000000000000000001`,
      ]),
    );
    expect(host.querySelector("form.composer")).toBeNull();
  });

  describe("Newsletter without the sender details", () => {
    it("says what is missing in plain words and offers no way to write an email", async () => {
      const server = fakeNewsletterServer({
        senderDetailsState: "not_configured",
      });
      const host = mount([{ campaign, revision }]);

      await vi.waitFor(() =>
        expect(host.textContent).toContain(
          "Foundry does not yet have the name and postal address that must " +
            "appear at the bottom of every email, so no campaign can be " +
            "written or sent.",
        ),
      );

      // Nothing that would store a revision is offered.
      await vi.waitFor(() =>
        expect(buttonNamed(host, "New email")!.disabled).toBe(true),
      );

      // The owner reads plain words. The setting names are there for whoever
      // installs them, behind the disclosure, not on the line.
      const line = host.querySelector(".connection-status-missing")!;
      expect(line.textContent).not.toContain("FOUNDRY_CAMPAIGN_LEGAL_NAME");

      const setupLink = Array.from(
        host.querySelectorAll<HTMLAnchorElement>("a"),
      ).find((link) => link.textContent === "How to set the sender details");
      expect(setupLink).toBeDefined();
      expect(setupLink!.getAttribute("href")).toBe(
        "https://github.com/Humber-Foundry/foundry-cms/blob/main/" +
          "docs/operations/brevo-test-delivery-readiness.md",
      );
      expect(setupLink!.target).toBe("_blank");
      expect(server.commands).toHaveLength(0);
    });

    it("shows the setting names to whoever opens the disclosure", async () => {
      fakeNewsletterServer({ senderDetailsState: "not_configured" });
      const host = mount([{ campaign, revision }]);

      // The disclosure's button shows only "?", so it is found by its
      // accessible name rather than by its text.
      await vi.waitFor(() =>
        expect(host.querySelector(".connection-status-missing")).not.toBeNull(),
      );
      await userEvent.click(
        page.getByRole("button", { name: "Which settings are these?" }),
      );
      await vi.waitFor(() =>
        expect(host.textContent).toContain("FOUNDRY_CAMPAIGN_LEGAL_NAME"),
      );
      expect(host.textContent).toContain("FOUNDRY_CAMPAIGN_POSTAL_ADDRESS");
    });

    it("leaves everything working once the settings are set", async () => {
      fakeNewsletterServer();
      const host = mount([{ campaign, revision }]);

      await vi.waitFor(() =>
        expect(buttonNamed(host, "New email")!.disabled).toBe(false),
      );
      expect(host.textContent).not.toContain(
        "Foundry does not yet have the name and postal address",
      );
    });
  });
});
