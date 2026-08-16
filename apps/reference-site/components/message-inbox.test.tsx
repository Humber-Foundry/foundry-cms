import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createPublicFormId,
  createPublicFormReceiptId,
  type PublicFormInboxMessage,
} from "@humber-foundry/application";

import { MessageInbox } from "./message-inbox";

function message(
  overrides: Partial<PublicFormInboxMessage> = {},
): PublicFormInboxMessage {
  return {
    formId: createPublicFormId("contact"),
    receiptId: createPublicFormReceiptId("receipt-01"),
    acceptedAt: "2026-07-21T20:00:00.000Z",
    read: false,
    senderName: "Ada Lovelace",
    replyAddress: "ada@example.com",
    preview: "Please call me back about the quote.",
    payloadDeleted: false,
    ...overrides,
  };
}

describe("message inbox", () => {
  it("shows who wrote, when, which form and a preview", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox messages={[message()]} olderCursor={null} />,
    );

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Please call me back about the quote.");
    expect(markup).toContain("contact");
    expect(markup).toContain("21 Jul 2026, 1:00 pm");
    expect(markup).toContain('href="/dash/forms/receipt-01"');
  });

  it("marks a message nobody has opened yet", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox
        messages={[message(), message({ receiptId: createPublicFormReceiptId("receipt-02"), read: true })]}
        olderCursor={null}
      />,
    );

    expect(markup).toContain("message-unread");
    expect(markup).toContain("Unread");
  });

  it("offers a reply link only when the visitor left an address", () => {
    const withAddress = renderToStaticMarkup(
      <MessageInbox messages={[message()]} olderCursor={null} />,
    );
    const withoutAddress = renderToStaticMarkup(
      <MessageInbox
        messages={[message({ replyAddress: null })]}
        olderCursor={null}
      />,
    );

    expect(withAddress).toContain('href="mailto:ada@example.com"');
    expect(withoutAddress).not.toContain("mailto:");
  });

  it("never builds a reply link from an address it cannot trust", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox
        messages={[
          message({
            replyAddress: "ada@example.com?bcc=someone-else@example.net",
          }),
        ]}
        olderCursor={null}
      />,
    );

    expect(markup).not.toContain("mailto:");
  });

  it("names the sender plainly when the form collected no name", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox
        messages={[message({ senderName: null, replyAddress: null })]}
        olderCursor={null}
      />,
    );

    expect(markup).toContain("Someone");
  });

  it("says an erased message has no content left to read", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox
        messages={[
          message({ payloadDeleted: true, preview: "", senderName: null }),
        ]}
        olderCursor={null}
      />,
    );

    expect(markup).toContain("erased");
  });

  it("explains an empty inbox instead of showing an empty table", () => {
    const markup = renderToStaticMarkup(
      <MessageInbox messages={[]} olderCursor={null} />,
    );

    expect(markup).toContain("No messages yet");
  });

  it("links to older messages only when there are older messages", () => {
    const withOlder = renderToStaticMarkup(
      <MessageInbox
        messages={[message()]}
        olderCursor={createPublicFormReceiptId("receipt-01")}
      />,
    );
    const withoutOlder = renderToStaticMarkup(
      <MessageInbox messages={[message()]} olderCursor={null} />,
    );

    expect(withOlder).toContain('href="/dash/forms?older=receipt-01"');
    expect(withoutOlder).not.toContain("older=");
  });
});
