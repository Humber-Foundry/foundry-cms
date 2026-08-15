import { describe, expect, it } from "vitest";

import { createPublicFormId } from "./public-form";
import {
  createPublicFormInboxPlan,
  summarizePublicFormSubmission,
} from "./public-form-inbox";

const contact = createPublicFormId("contact");

const plan = createPublicFormInboxPlan([
  {
    id: contact,
    fields: [
      { id: "name", required: true, maximumLength: 100, inboxRole: "sender" },
      {
        id: "email",
        required: false,
        maximumLength: 254,
        inboxRole: "replyAddress",
      },
      {
        id: "message",
        required: true,
        maximumLength: 2_000,
        inboxRole: "preview",
      },
    ],
  },
]);

describe("public form inbox summary", () => {
  it("reads the sender, reply address and preview named by the form", () => {
    expect(
      summarizePublicFormSubmission({
        plan,
        formId: contact,
        fields: {
          name: "  Ada Lovelace ",
          email: "ada@example.com",
          message: "Please call me back about the quote.",
        },
      }),
    ).toEqual({
      senderName: "Ada Lovelace",
      replyAddress: "ada@example.com",
      preview: "Please call me back about the quote.",
    });
  });

  it("keeps the preview on one line and bounds its length", () => {
    const summary = summarizePublicFormSubmission({
      plan,
      formId: contact,
      fields: {
        name: "Ada",
        message: `first line\n\n  second   line ${"long ".repeat(80)}`,
      },
    });

    expect(summary.preview).not.toContain("\n");
    expect(summary.preview.startsWith("first line second line long")).toBe(
      true,
    );
    expect(summary.preview.length).toBeLessThanOrEqual(161);
    expect(summary.preview.endsWith("…")).toBe(true);
  });

  it("refuses a reply address that is not a plain email address", () => {
    for (const email of [
      "not-an-address",
      "ada@example.com, other@example.com",
      "ada@example.com\r\nbcc: other@example.com",
      "<ada@example.com>",
      "ada@example.com?bcc=someone-else@example.net",
      "ada@example.com?subject=Approved",
      "ada@example",
      "  ",
      `${"a".repeat(250)}@example.com`,
    ]) {
      expect(
        summarizePublicFormSubmission({
          plan,
          formId: contact,
          fields: { name: "Ada", email, message: "Hello" },
        }).replyAddress,
      ).toBeNull();
    }
  });

  it("reports no sender or reply address when the visitor gave neither", () => {
    expect(
      summarizePublicFormSubmission({
        plan,
        formId: contact,
        fields: { message: "Hello" },
      }),
    ).toEqual({
      senderName: null,
      replyAddress: null,
      preview: "Hello",
    });
  });

  it("previews the first declared field when the form names no preview field", () => {
    const unnamed = createPublicFormInboxPlan([
      {
        id: contact,
        fields: [
          { id: "name", required: true, maximumLength: 100, inboxRole: "sender" },
          { id: "subject", required: false, maximumLength: 100 },
          { id: "message", required: true, maximumLength: 2_000 },
        ],
      },
    ]);

    expect(
      summarizePublicFormSubmission({
        plan: unnamed,
        formId: contact,
        fields: { name: "Ada", subject: "Quote", message: "Hello" },
      }).preview,
    ).toBe("Quote");
  });

  it("summarizes a form the installation no longer declares", () => {
    expect(
      summarizePublicFormSubmission({
        plan,
        formId: createPublicFormId("retired"),
        fields: { name: "Ada", message: "Hello" },
      }),
    ).toEqual({ senderName: null, replyAddress: null, preview: "" });
  });

  it("ignores field values that are not text", () => {
    expect(
      summarizePublicFormSubmission({
        plan,
        formId: contact,
        fields: { name: 42, email: null, message: { nested: true } },
      }),
    ).toEqual({ senderName: null, replyAddress: null, preview: "" });
  });
});
