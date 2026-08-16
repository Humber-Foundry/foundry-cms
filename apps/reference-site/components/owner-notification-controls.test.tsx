import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormReceiptId,
  type FailedPublicFormDelivery,
} from "@humber-foundry/application";

import { OwnerNotificationTable } from "./owner-notification-controls";

const failed: FailedPublicFormDelivery = {
  deliveryId: createPublicFormDeliveryId("delivery-03"),
  formId: createPublicFormId("contact"),
  receiptId: createPublicFormReceiptId("receipt-03"),
  attempts: 3,
  errorCode: "adapter_outcome_unknown",
  updatedAt: "2026-07-21T20:00:00.000Z",
};

function render(
  deliveries: ReadonlyArray<FailedPublicFormDelivery>,
  message = "",
) {
  return renderToStaticMarkup(
    <OwnerNotificationTable
      failedDeliveries={deliveries}
      message={message}
      onSendAgain={vi.fn()}
      pending={false}
    />,
  );
}

describe("owner notification controls", () => {
  it("names the alert, not the message, and offers to send it again", () => {
    const markup = render([failed]);

    expect(markup).toContain("Send the alert again");
    expect(markup).toContain("3 attempts");
    expect(markup).not.toContain("Failed delivery");
  });

  it("says why an alert stopped in words, keeping the code for support", () => {
    const markup = render([failed]);

    expect(markup).toContain("The email service did not answer.");
    expect(markup).toContain("<code>adapter_outcome_unknown</code>");
  });

  it("falls back to a plain sentence for a code it does not know", () => {
    const markup = render([{ ...failed, errorCode: "provider_rejected" }]);

    expect(markup).toContain("The email service refused it.");
  });

  it("confirms the alerts arrived when none failed", () => {
    expect(render([])).toContain("reached your email");
  });

  it("still says what happened after the last stopped alert is sent again", () => {
    const markup = render([], "Sending again.");

    expect(markup).toContain("Sending again.");
    expect(markup).toContain('role="status"');
  });
});
