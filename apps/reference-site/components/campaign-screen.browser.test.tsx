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

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => undefined,
    refresh: () => undefined,
  }),
}));

import { CampaignScreen } from "./campaign-screen";

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

describe("one campaign's screen, browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  /**
   * One fake server for this campaign's screen.
   *
   * It answers the two reads the screen makes and records every command. A
   * test moves the campaign forward by changing what the read returns, exactly
   * as a real server would, so nothing on the screen can look finished unless
   * the server says it is.
   */
  function fakeNewsletterServer(
    options: {
      deliveryState?: string;
      deliveryMissingSettings?: ReadonlyArray<string>;
      senderDetailsState?: string;
    } = {},
  ) {
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
            bytes:
              '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
              "<title>September news</title></head><body><p>Preview</p>" +
              "<h2><strong>News</strong></h2></body></html>",
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
          eligibleSubscriberCount: 412,
        },
        sendSummary: {
          campaignRevisionId: revision.id,
          recipientCount: 412,
          subject: revision.subject,
          senderName: "Example News",
          senderAddress: "news@example.test",
          replyAddress: "news@example.test",
          footer:
            "Example News \u00b7 1 Harbour Road \u00b7 Contact: https://example.test/",
          unsubscribeAddress:
            "https://example.test/unsubscribe?token={{foundry.unsubscribe.token}}",
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
            return Response.json({
              authorization: { id: state.authorizationId },
            });
          }
          if (command.action === "edit") {
            // A new revision renders to a new fingerprint, so the delivered
            // test no longer covers what the email says.
            state.campaignFingerprint = "fingerprint-two";
            const input = (command.input ?? {}) as Record<string, unknown>;
            return Response.json({
              campaign: { ...campaign, version: 2 },
              revision: { ...revision, ...input, revisionNumber: 2 },
            });
          }
          return Response.json({});
        }
        if (url.includes("readiness=delivery")) {
          const senderDetailsState = options.senderDetailsState ?? "connected";
          return Response.json({
            delivery: {
              state: options.deliveryState ?? "connected",
              missingSettings: options.deliveryMissingSettings ?? [],
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
        return Response.json(report());
      },
    );
    return { campaign, revision, commands, state };
  }

  function mount(revision: CampaignRevision, role: "owner" | "editor") {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(CampaignScreen, {
          csrfToken: "csrf",
          role,
          media: {
            csrfToken: "csrf",
            workspaceId: "workspace_000000000000000000000001",
            siteImages: [],
          },
          initialRevision: revision,
        }),
      );
    });
    return host;
  }

  const buttonNamed = (host: HTMLElement, name: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === name,
    );

  it("preserves rich email content when editing another campaign field", async () => {
    const server = fakeNewsletterServer();
    const host = mount(server.revision, "owner");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Change the email")).toBeDefined(),
    );
    await userEvent.click(buttonNamed(host, "Change the email")!);
    const editSubject = Array.from(
      host.querySelectorAll<HTMLInputElement>('input[name="subject"]'),
    ).find(({ value }) => value === "September news");
    expect(editSubject).toBeDefined();
    await userEvent.fill(editSubject!, "Updated subject");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() =>
      expect(
        server.commands.some(({ action }) => action === "edit"),
      ).toBe(true),
    );
    expect(server.commands.at(-1)).toMatchObject({
      action: "edit",
      input: {
        subject: "Updated subject",
        emailContent: richEmailContent,
      },
    });
  });

  it("draws the exact email the provider will send, at two widths", async () => {
    const server = fakeNewsletterServer();
    const host = mount(server.revision, "owner");

    // The frame draws the server's own rendered bytes, not a second drawing
    // of the same content in the dashboard's styles.
    const frame = await vi.waitFor(() => {
      const found = host.querySelector<HTMLIFrameElement>(
        "section.email-preview iframe",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(frame.srcdoc).toContain("<title>September news</title>");
    expect(frame.srcdoc).toContain("<h2><strong>News</strong></h2>");
    // Nothing in the frame may run or reach off this site.
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.sandbox.value).toBe("allow-same-origin");

    // An email is built for 600 pixels. The phone width is the same email at
    // 390, never a scaled picture of the wider one.
    expect(frame.style.width).toBe("600px");
    await userEvent.click(buttonNamed(host, "On a phone")!);
    expect(frame.style.width).toBe("390px");
    expect(buttonNamed(host, "On a phone")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(buttonNamed(host, "On a computer")!);
    expect(frame.style.width).toBe("600px");

    // The rendered text and the content fingerprint arrive with the report.
    await vi.waitFor(() =>
      expect(host.textContent).toContain("html-one"),
    );
  });

  it("says why a test cannot go out in local development, and does not look broken", async () => {
    const server = fakeNewsletterServer({
      deliveryState: "local_development",
      deliveryMissingSettings: [
        "FOUNDRY_BREVO_API_KEY",
        "FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON",
      ],
    });
    const host = mount(server.revision, "owner");

    // The button stays on the step, and the step says exactly why it cannot
    // work here.
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")).toBeDefined(),
    );
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")!.disabled).toBe(true),
    );
    expect(host.textContent).toContain(
      "No test can go out from here. Nothing is broken: a test goes out as " +
        "soon as this site is connected to an email provider.",
    );
    expect(host.textContent).toContain(
      "Email is off in local development, because this site holds no email " +
        "provider connection.",
    );
    expect(host.textContent).toContain(
      "On a live site the email connection is set in Settings → Email.",
    );
    const settingsLink = Array.from(
      host.querySelectorAll<HTMLAnchorElement>("a"),
    ).find((link) => link.textContent === "Settings → Email");
    expect(settingsLink?.getAttribute("href")).toBe("/dash/settings/email");
    const guideLink = Array.from(
      host.querySelectorAll<HTMLAnchorElement>("a"),
    ).find((link) => link.textContent === "How to connect email");
    expect(guideLink).toBeDefined();

    // The setting names a connected site holds are kept for whoever connects
    // one, behind a closed disclosure. Nothing outside it names a setting, so
    // the open screen carries no configuration name.
    const disclosure = host.querySelector<HTMLDetailsElement>(
      "details.connection-status-details",
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure!.open).toBe(false);
    expect(disclosure!.querySelector("summary")?.textContent).toBe(
      "Technical details",
    );
    expect(disclosure!.textContent).toContain("FOUNDRY_BREVO_API_KEY");
    expect(disclosure!.textContent).toContain(
      "FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON",
    );
    const outsideDisclosure = host.textContent!.replace(
      disclosure!.textContent!,
      "",
    );
    expect(outsideDisclosure).not.toContain("FOUNDRY_");
    // Nothing was sent, and nothing reads as a fault.
    expect(server.commands).toHaveLength(0);
  });

  it("makes the owner read the same review before it will approve", async () => {
    const server = fakeNewsletterServer();
    server.state.testedFingerprint = "fingerprint-one";
    server.state.readiness = "ready";
    const host = mount(server.revision, "owner");

    const approve = await vi.waitFor(() => {
      const found = buttonNamed(host, "Approve this email for sending");
      expect(found).toBeDefined();
      return found!;
    });
    expect(host.querySelector(".send-review")!.textContent).toContain(
      "Going to 412 people.",
    );
    expect(approve.disabled).toBe(true);

    await userEvent.click(host.querySelector('input[name="sendReviewed"]')!);
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);
    expect(server.commands).toContainEqual({
      action: "authorize_bulk",
      campaignId: server.campaign.id,
      testExecutionId: "40000000-0000-4000-8000-000000000001",
    });

    // One tick opens one step. Approving is a step, so the send that follows
    // needs its own reading; otherwise the same tick would send the email.
    const send = await vi.waitFor(() => {
      const found = buttonNamed(host, "Send to 412 people now");
      expect(found).toBeDefined();
      return found!;
    });
    expect(
      host.querySelector<HTMLInputElement>('input[name="sendReviewed"]')!
        .checked,
    ).toBe(false);
    expect(send.disabled).toBe(true);
  });

  it("makes the owner read a review naming the list before it will send", async () => {
    const server = fakeNewsletterServer();
    server.state.testedFingerprint = "fingerprint-one";
    server.state.readiness = "ready";
    server.state.authorizationId = "50000000-0000-4000-8000-000000000001";
    const host = mount(server.revision, "owner");

    const confirm = await vi.waitFor(() => {
      const found = buttonNamed(host, "Send to 412 people now");
      expect(found).toBeDefined();
      return found!;
    });

    // Everything the owner has to read before a send, from the revision that
    // would go out.
    const review = host.querySelector(".send-review")!;
    expect(review.textContent).toContain("Going to 412 people.");
    expect(review.textContent).toContain("September news");
    expect(review.textContent).toContain("Example News");
    expect(review.textContent).toContain("news@example.test");
    expect(review.textContent).toContain("1 Harbour Road");
    // The unsubscribe address reads as an address, with no token marker.
    expect(review.textContent).toContain("https://example.test/unsubscribe");
    expect(review.textContent).not.toContain("foundry.unsubscribe.token");

    // Nothing goes out until the owner says they read it.
    const scheduleButton = buttonNamed(host, "Send it then")!;
    expect(confirm.disabled).toBe(true);
    expect(scheduleButton.disabled).toBe(true);
    await userEvent.click(
      host.querySelector('input[name="sendReviewed"]')!,
    );
    expect(confirm.disabled).toBe(false);
    expect(server.commands).toHaveLength(0);

    await userEvent.click(confirm);
    expect(server.commands).toContainEqual({
      action: "send_bulk_now",
      campaignId: server.campaign.id,
      authorizationId: "50000000-0000-4000-8000-000000000001",
    });
  });

  it("opens sending only after a delivered test is confirmed, and closes it again on an edit", async () => {
    const server = fakeNewsletterServer();
    const host = mount(server.revision, "owner");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")).toBeDefined(),
    );

    // Nothing can be approved or sent before a test exists.
    expect(buttonNamed(host, "Approve this email for sending")).toBeUndefined();
    expect(buttonNamed(host, "Send it now")).toBeUndefined();
    expect(host.textContent).toContain(
      "Send a test and confirm it arrived first.",
    );

    await userEvent.click(buttonNamed(host, "Send me a test")!);
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

    // The save closes the writing box and the steps come back, now asking for
    // a new test.
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")).toBeDefined(),
    );
    expect(buttonNamed(host, "Approve this email for sending")).toBeUndefined();
    expect(host.textContent).toContain(
      "You changed the email after the last test, so that test no longer counts.",
    );
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
    const host = mount(server.revision, "owner");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Call this send off")).toBeDefined(),
    );
    expect(host.textContent).toContain("2026-09-25 at 09:00:00");

    // The same rule holds for a send that failed. The screen reads the whole
    // report back after every step, so calling the schedule off is what brings
    // the server's next answer onto the screen.
    server.state.schedule = null;
    server.state.sendOperation = failed;
    await userEvent.click(buttonNamed(host, "Call this send off")!);
    expect(server.commands).toContainEqual({
      action: "cancel_bulk_schedule",
      scheduleId: scheduled.id,
    });
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
    const host = mount(server.revision, "editor");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")).toBeDefined(),
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

  it("shows an Editor a scheduled send without offering to call it off", async () => {
    const server = fakeNewsletterServer();
    server.state.schedule = {
      id: "70000000-0000-4000-8000-000000000001",
      state: "active",
      localDateTime: "2026-09-25T09:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: "2026-09-25T16:00:00.000Z",
    };
    const host = mount(server.revision, "editor");

    await vi.waitFor(() =>
      expect(host.textContent).toContain("2026-09-25 at 09:00:00"),
    );

    // An Editor reads the true state and is offered no control over it.
    expect(host.textContent).toContain(
      "Only the site owner can start, change or call off a send.",
    );
    expect(buttonNamed(host, "Call this send off")).toBeUndefined();
  });

  it("keeps the test and send steps shut while email is not connected", async () => {
    const server = fakeNewsletterServer({ deliveryState: "not_configured" });
    const host = mount(server.revision, "owner");

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")).toBeDefined(),
    );

    await vi.waitFor(() =>
      expect(buttonNamed(host, "Send me a test")!.disabled).toBe(true),
    );
    expect(host.textContent).toContain(
      "Email is not connected yet, so no test can go out.",
    );
    // The person who can fix it gets a real link to the setup document, not
    // a bare repository path they cannot open.
    const setupLink = Array.from(
      host.querySelectorAll<HTMLAnchorElement>("a"),
    ).find((link) => link.textContent === "How to connect email");
    expect(setupLink).toBeDefined();
    expect(setupLink!.getAttribute("href")).toBe(
      "https://github.com/Humber-Foundry/foundry-cms/blob/main/" +
        "docs/operations/brevo-test-delivery-readiness.md",
    );
    expect(setupLink!.target).toBe("_blank");
    expect(server.commands).toHaveLength(0);
  });

  it("offers no way to change the email while the sender details are missing", async () => {
    const server = fakeNewsletterServer({
      senderDetailsState: "not_configured",
    });
    const host = mount(server.revision, "owner");

    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        "Foundry does not yet have the name and postal address that must " +
          "appear at the bottom of every email, so no campaign can be " +
          "written or sent.",
      ),
    );

    // Nothing that would store a revision is offered.
    await vi.waitFor(() =>
      expect(buttonNamed(host, "Change the email")!.disabled).toBe(true),
    );
    expect(host.querySelector("form.composer")).toBeNull();
    expect(server.commands).toHaveLength(0);
  });
});
