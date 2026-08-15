import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createPublicFormId,
  createPublicFormReceiptId,
  type FailedPublicFormDelivery,
  type SuspectedSpamSubmission,
} from "@humber-foundry/application";

import { OwnerNotificationTable } from "./owner-notification-controls";
import { SpamReviewList } from "./spam-review-controls";

const held: SuspectedSpamSubmission = {
  formId: createPublicFormId("contact"),
  receiptId: createPublicFormReceiptId("receipt-03"),
  acceptedAt: "2026-07-21T20:00:00.000Z",
};

const failed: FailedPublicFormDelivery = {
  deliveryId: "delivery-03" as FailedPublicFormDelivery["deliveryId"],
  formId: createPublicFormId("contact"),
  receiptId: createPublicFormReceiptId("receipt-03"),
  attempts: 3,
  errorCode: "provider_rejected",
  updatedAt: "2026-07-21T20:00:00.000Z",
};

describe("spam review controls", () => {
  it("asks in plain words whether a held message is spam", () => {
    const markup = renderToStaticMarkup(
      <SpamReviewList canAccept suspectedSpam={[held]} />,
    );

    expect(markup).toContain("Not spam — accept it");
    expect(markup).toContain('href="/dash/forms/receipt-03"');
    expect(markup).toContain("21 Jul 2026, 1:00 pm");
    expect(markup).not.toContain("Held submission");
    expect(markup).not.toContain("Release and notify");
  });

  it("keeps held content out of the list", () => {
    const markup = renderToStaticMarkup(
      <SpamReviewList canAccept suspectedSpam={[held]} />,
    );

    expect(markup).toContain("Open it to read what was sent.");
  });

  it("tells an editor who decides instead of showing a dead button", () => {
    const markup = renderToStaticMarkup(
      <SpamReviewList canAccept={false} suspectedSpam={[held]} />,
    );

    expect(markup).toContain("The owner decides this one");
    expect(markup).not.toContain("<button");
  });

  it("says nothing is waiting when no message was held", () => {
    const markup = renderToStaticMarkup(
      <SpamReviewList canAccept suspectedSpam={[]} />,
    );

    expect(markup).toContain("held here instead of reaching your inbox");
  });
});

describe("owner notification controls", () => {
  it("names the alert, not the message, and offers to send it again", () => {
    const markup = renderToStaticMarkup(
      <OwnerNotificationTable failedDeliveries={[failed]} />,
    );

    expect(markup).toContain("Send the alert again");
    expect(markup).toContain("provider_rejected");
    expect(markup).toContain("3 attempts");
    expect(markup).not.toContain("Failed delivery");
  });

  it("confirms the alerts arrived when none failed", () => {
    const markup = renderToStaticMarkup(
      <OwnerNotificationTable failedDeliveries={[]} />,
    );

    expect(markup).toContain("reached your email");
  });
});
