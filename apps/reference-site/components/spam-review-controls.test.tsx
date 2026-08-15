import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createPublicFormId,
  createPublicFormReceiptId,
  type SuspectedSpamSubmission,
} from "@humber-foundry/application";

import { SpamReviewList } from "./spam-review-controls";

const held: SuspectedSpamSubmission = {
  formId: createPublicFormId("contact"),
  receiptId: createPublicFormReceiptId("receipt-03"),
  acceptedAt: "2026-07-21T20:00:00.000Z",
};

function render(
  overrides: Partial<Parameters<typeof SpamReviewList>[0]> = {},
) {
  return renderToStaticMarkup(
    <SpamReviewList
      canAccept
      message=""
      onAccept={vi.fn()}
      pending={false}
      suspectedSpam={[held]}
      {...overrides}
    />,
  );
}

describe("spam review controls", () => {
  it("asks in plain words whether a held message is spam", () => {
    const markup = render();

    expect(markup).toContain("Not spam — accept it");
    expect(markup).toContain('href="/dash/forms/receipt-03"');
    expect(markup).toContain("21 Jul 2026, 1:00 pm");
    expect(markup).not.toContain("Held submission");
    expect(markup).not.toContain("Release and notify");
  });

  it("keeps held content out of the list", () => {
    expect(render()).toContain("Open it to read what was sent.");
  });

  it("tells an editor who decides instead of showing a dead button", () => {
    const markup = render({ canAccept: false });

    expect(markup).toContain("The owner decides this one");
    expect(markup).not.toContain("<button");
  });

  it("says nothing is waiting when no message was held", () => {
    expect(render({ suspectedSpam: [] })).toContain(
      "held here instead of reaching your inbox",
    );
  });
});
