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
      schemaVersion: "1.7.0",
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
          workspaceId: "workspace_000000000000000000000001",
          siteImages: [],
          postSources: [],
          role: "owner",
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

  /**
   * One fake server for the sending steps.
   *
   * It answers the two reads the steps make and records every command. The
   * test moves the campaign forward by changing what the read returns, exactly
   * as a real server would, so nothing in the steps can look finished unless
   * the server says it is.
   */
  function fakeNewsletterServer(options: { deliveryState?: string } = {}) {
    const campaign = {
      id: "20000000-0000-4000-8000-000000000002",
      siteId: createSiteId("site_reference"),
      lifecycleState: "draft",
      currentRevisionId: "30000000-0000-4000-8000-000000000002",
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
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
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
      schemaVersion: "1.7.0",
      rendererVersion: "1".repeat(40),
      createdAt: campaign.createdAt,
      createdByActorId: "membership-owner",
    } as CampaignRevision;
    const executionId = "40000000-0000-4000-8000-000000000001";
    const commands: Array<Record<string, unknown>> = [];
    const state = {
      campaignFingerprint: "fingerprint-one",
      testedFingerprint: null as string | null,
      readiness: "live_test_required",
      authorizationId: null as string | null,
      schedule: null as Record<string, unknown> | null,
      sendOperation: null as Record<string, unknown> | null,
    };

    function report() {
      return {
        rendered: {
          campaignId: campaign.id,
          campaignRevisionId: revision.id,
          revisionNumber: 1,
          html: {
            channel: "html",
            bytes: "<p>News</p>",
            fingerprint: "html-one",
            schemaVersion: "1.7.0",
            rendererVersion: revision.rendererVersion,
          },
          text: {
            channel: "text",
            bytes: "News",
            fingerprint: "text-one",
            schemaVersion: "1.7.0",
            rendererVersion: revision.rendererVersion,
          },
          campaignFingerprint: state.campaignFingerprint,
          eligibleSubscriberCount: 12,
        },
        testEvidence:
          state.testedFingerprint === null
            ? null
            : {
                executionId,
                campaignId: campaign.id,
                campaignRevisionId: revision.id,
                campaignFingerprint: state.testedFingerprint,
                providerCampaignId: "provider-1",
                providerMessageId: "message-1",
                providerReceiptHash: "receipt-hash",
                acceptedAt: "2026-09-01T01:00:00.000Z",
              },
        testReadiness: {
          state: state.readiness,
          testDeliveryReady: state.readiness === "ready",
          provider: "brevo",
          configurationFingerprint: "0".repeat(64),
          ownershipEvidenceId: "evidence-1",
        },
        bulkState: {
          authorization:
            state.authorizationId === null
              ? null
              : {
                  id: state.authorizationId,
                  campaignFingerprint: state.campaignFingerprint,
                  testExecutionId: executionId,
                  state: "active",
                  authorizedAt: "2026-09-01T02:00:00.000Z",
                },
          schedule: state.schedule,
          sendOperation: state.sendOperation,
        },
        testRecipients: {
          ids: ["membership-owner"],
          yours: "membership-owner",
        },
      };
    }

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
          if (command.action === "request_test") {
            state.testedFingerprint = state.campaignFingerprint;
            state.readiness = "owner_confirmation_required";
            return Response.json({ executionId, state: "accepted" });
          }
          if (command.action === "confirm_test_receipt") {
            state.readiness = "ready";
            return Response.json({ executionId });
          }
          if (command.action === "authorize_bulk") {
            state.authorizationId = "50000000-0000-4000-8000-000000000001";
            return Response.json({ authorization: { id: state.authorizationId } });
          }
          if (command.action === "edit") {
            // A new revision renders to a new fingerprint, so the delivered
            // test no longer covers what the email says.
            state.campaignFingerprint = "fingerprint-two";
            return Response.json({
              campaign: { ...campaign, version: 2 },
              revision: { ...revision, revisionNumber: 2 },
            });
          }
          return Response.json({});
        }
        if (url.includes("readiness=delivery")) {
          return Response.json({
            delivery: {
              state: options.deliveryState ?? "connected",
              missingSettings: [],
              providerHealth: null,
              setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
            },
          });
        }
        if (url.includes("campaignId=")) return Response.json(report());
        return Response.json({ campaigns: [{ campaign, revision }] });
      },
    );
    return { campaign, revision, commands, state };
  }

  function mount(
    campaign: Campaign,
    revision: CampaignRevision,
    role: "owner" | "editor",
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(CampaignControls, {
          csrfToken: "csrf",
          workspaceId: "workspace_000000000000000000000001",
          siteImages: [],
          postSources: [],
          role,
          initialCampaigns: [{ campaign, revision }],
        }),
      );
    });
    return host;
  }

  const buttonNamed = (host: HTMLElement, name: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === name,
    );

  it("opens sending only after a delivered test is confirmed, and closes it again on an edit", async () => {
    const server = fakeNewsletterServer();
    const host = mount(server.campaign, server.revision, "owner");

    await userEvent.click(page.getByRole("button", { name: "Sending steps" }));
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send a test email")).toBeDefined(),
    );

    // Nothing can be approved or sent before a test exists.
    expect(buttonNamed(host, "Approve this email for sending")).toBeUndefined();
    expect(buttonNamed(host, "Send it now")).toBeUndefined();
    expect(host.textContent).toContain(
      "Send a test and confirm it arrived first.",
    );

    await userEvent.click(buttonNamed(host, "Send a test email")!);
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Confirm the test arrived")).toBeDefined(),
    );

    // The delivered test alone is not a review. Approving stays shut until a
    // person says they opened it.
    expect(buttonNamed(host, "Approve this email for sending")).toBeUndefined();
    expect(buttonNamed(host, "Confirm the test arrived")!.disabled).toBe(true);
    expect(
      server.commands.some(({ action }) => action === "confirm_test_receipt"),
    ).toBe(false);

    await userEvent.click(host.querySelector("input[type=checkbox]")!);
    expect(buttonNamed(host, "Confirm the test arrived")!.disabled).toBe(false);
    await userEvent.click(buttonNamed(host, "Confirm the test arrived")!);

    await vi.waitFor(() =>
      expect(
        buttonNamed(host, "Approve this email for sending"),
      ).toBeDefined(),
    );
    expect(server.commands).toContainEqual({
      action: "confirm_test_receipt",
      executionId: "40000000-0000-4000-8000-000000000001",
    });

    // Changing the email makes a new revision, so the confirmed test stops
    // covering it and the steps go back to asking for a test.
    await userEvent.click(buttonNamed(host, "Change the email")!);
    const subject = Array.from(
      host.querySelectorAll<HTMLInputElement>('input[name="subject"]'),
    ).find(({ value }) => value === "September news");
    await userEvent.fill(subject!, "October news");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() =>
      expect(
        buttonNamed(host, "Approve this email for sending"),
      ).toBeUndefined(),
    );
    expect(host.textContent).toContain(
      "You changed the email after the last test, so that test no longer counts.",
    );
    expect(buttonNamed(host, "Send a test email")).toBeDefined();
  });

  it("keeps a scheduled send cancellable and a failed send retryable after an edit", async () => {
    // The server still holds the schedule and the send operation, so the
    // screen must keep showing them. Testing the approval first would hide the
    // controls exactly when they are needed.
    const scheduled = {
      id: "70000000-0000-4000-8000-000000000001",
      state: "active",
      localDateTime: "2026-09-25T09:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: "2026-09-25T16:00:00.000Z",
    };
    const failed = {
      id: "60000000-0000-4000-8000-000000000001",
      state: "failed",
      attempt: 1,
      scheduledInstant: null,
      recipientCount: 128,
      detail: "provider_timeout",
      updatedAt: "2026-09-18T11:00:00.000Z",
    };
    const server = fakeNewsletterServer();
    // The email was changed after it was approved, so no confirmed test covers
    // it any more.
    server.state.testedFingerprint = "fingerprint-one";
    server.state.campaignFingerprint = "fingerprint-two";
    server.state.readiness = "ready";
    server.state.schedule = scheduled;
    const host = mount(server.campaign, server.revision, "owner");

    await userEvent.click(page.getByRole("button", { name: "Sending steps" }));
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Call this send off")).toBeDefined(),
    );
    expect(host.textContent).toContain("2026-09-25 at 09:00:00");
    await userEvent.click(buttonNamed(host, "Call this send off")!);
    expect(server.commands).toContainEqual({
      action: "cancel_bulk_schedule",
      scheduleId: scheduled.id,
    });

    // The same rule holds for a send that failed.
    server.state.schedule = null;
    server.state.sendOperation = failed;
    await userEvent.click(page.getByRole("button", { name: "Sending steps" }));
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Try the send again")).toBeDefined(),
    );
    expect(host.textContent).toContain("Reason: provider_timeout");
    await userEvent.click(buttonNamed(host, "Try the send again")!);
    expect(server.commands).toContainEqual({
      action: "retry_bulk_send",
      campaignId: server.campaign.id,
      operationId: failed.id,
    });
  });

  it("tells an Editor which steps belong to the site owner", async () => {
    const server = fakeNewsletterServer();
    const host = mount(server.campaign, server.revision, "editor");

    await userEvent.click(page.getByRole("button", { name: "Sending steps" }));
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send a test email")).toBeDefined(),
    );

    expect(host.textContent).toContain(
      "Only the site owner can send an email to subscribers.",
    );
    expect(host.textContent).toContain(
      "The site owner has to confirm the test arrived.",
    );
    expect(buttonNamed(host, "Approve this email for sending")).toBeUndefined();
    expect(buttonNamed(host, "Send it now")).toBeUndefined();
  });

  it("keeps the test and send steps shut while email is not connected", async () => {
    const server = fakeNewsletterServer({ deliveryState: "not_configured" });
    const host = mount(server.campaign, server.revision, "owner");

    await userEvent.click(page.getByRole("button", { name: "Sending steps" }));
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send a test email")).toBeDefined(),
    );

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send a test email")!.disabled).toBe(true),
    );
    expect(host.textContent).toContain(
      "Email is not connected yet, so no test can go out.",
    );
    expect(server.commands).toHaveLength(0);
  });
});
