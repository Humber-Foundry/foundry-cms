import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPublicFormApplication,
  createPublicFormId,
  createPublicFormInboxPlan,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import { contactFormEnvelope } from "../components/contact-form-envelope";
import { installedPublicForms } from "../foundry/public-forms";
import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

/**
 * The contact form block sends one envelope. This test takes that exact
 * envelope, runs it through the real acceptance rules and the real store, then
 * reads it back the way the Messages screen does.
 *
 * It is the join between the two halves the browser cannot run together on a
 * development machine: the form's own send (covered in
 * `components/contact-form.browser.test.tsx`) and the inbox read.
 */

const { database } = useMigratedTestDatabase([
  "0003_public_forms.sql",
  "0004_public_form_notifications.sql",
  "0006_public_form_privacy.sql",
  "0026_public_form_inbox.sql",
]);

const siteId = createSiteId("site_reference");
const canonicalOrigin = "https://foundry.example";

const inboxPlan = createPublicFormInboxPlan(
  installedPublicForms.map((form) => ({
    id: createPublicFormId(form.id),
    fields: form.fields,
  })),
);

/**
 * Exactly what `ContactForm` puts in the body of its send, built by the same
 * function the form uses, so the two cannot drift apart.
 */
function envelopeFromTheForm(
  typed: Readonly<{ name: string; email?: string; message: string }>,
  submissionId: string,
) {
  return contactFormEnvelope({
    schemaVersion: "1.0.0",
    submissionId,
    name: typed.name,
    email: typed.email ?? "",
    message: typed.message,
    turnstileToken: "browser-token",
    // The visitor started typing a minute before they pressed the button, so
    // the message is not held as automated traffic.
    startedAt: "2026-07-27T19:59:00.000Z",
  });
}

function application(createId: () => string) {
  let counter = 0;
  return createPublicFormApplication({
    siteId,
    definitions: installedPublicForms.map((form) => ({
      id: createPublicFormId(form.id),
      schemaVersion: form.schemaVersion,
      allowedOrigin: canonicalOrigin,
      turnstileHostname: "foundry.example",
      turnstileAction: form.turnstileAction,
      fields: form.fields,
    })),
    store: createD1PublicFormAcceptanceStore(database),
    rateLimiter: { async allow() { return true; } },
    turnstile: {
      async verify() {
        return {
          success: true,
          hostname: "foundry.example",
          action: "contact",
        };
      },
    },
    clock: () => new Date("2026-07-27T20:00:00.000Z"),
    createId: (kind) => `${kind}_${createId()}_${(counter += 1)}`,
    async hash(value) {
      return `hash_${JSON.stringify(value).length}`;
    },
  });
}

async function accept(
  fields: Readonly<{ name: string; email?: string; message: string }>,
  id: string,
) {
  return application(() => id).commands.accept({
    formId: "contact",
    origin: canonicalOrigin,
    bodySize: 512,
    abuseKey: "contact:192.0.2.10",
    ...envelopeFromTheForm(fields, id),
  });
}

describe("a message sent from the contact form", () => {
  it("reaches the inbox with the sender, the reply address and a preview", async () => {
    await accept(
      {
        name: "Ada",
        email: "ada@example.com",
        message: "Please call me back about the workshop.",
      },
      "00000000-0000-4000-8000-000000000001",
    );

    const store = createD1PublicFormNotificationStore(database, { inboxPlan });
    const page = await store.listInbox({
      siteId,
      limit: 25,
      olderThanReceiptId: null,
    });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      formId: "contact",
      senderName: "Ada",
      replyAddress: "ada@example.com",
      preview: "Please call me back about the workshop.",
      read: false,
    });
    expect(page.unreadCount).toBe(1);
  });

  it("is counted against the form it came from", async () => {
    await accept(
      { name: "Ada", message: "First message." },
      "00000000-0000-4000-8000-000000000002",
    );
    await accept(
      { name: "Grace", message: "Second message." },
      "00000000-0000-4000-8000-000000000003",
    );

    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    await expect(store.countInboxByForm({ siteId })).resolves.toEqual({
      contact: 2,
    });
  });

  it("reaches the inbox without a reply address when none was typed", async () => {
    await accept(
      { name: "Ada", message: "No address today." },
      "00000000-0000-4000-8000-000000000004",
    );

    const store = createD1PublicFormNotificationStore(database, { inboxPlan });
    const page = await store.listInbox({
      siteId,
      limit: 25,
      olderThanReceiptId: null,
    });

    expect(page.messages[0]).toMatchObject({
      senderName: "Ada",
      replyAddress: null,
      preview: "No address today.",
    });
  });
});
