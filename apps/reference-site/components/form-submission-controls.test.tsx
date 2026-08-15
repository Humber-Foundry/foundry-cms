import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FormSubmissionActions } from "./form-submission-controls";

function render(classification: "accepted" | "suspected_spam") {
  return renderToStaticMarkup(
    <FormSubmissionActions
      classification={classification}
      message=""
      onDownload={vi.fn()}
      onErase={vi.fn()}
      onReclassify={vi.fn()}
      pending={false}
    />,
  );
}

describe("message actions", () => {
  it("names each action in plain words", () => {
    const markup = render("accepted");

    expect(markup).toContain("What you can do with this message");
    expect(markup).toContain("Download a copy");
    expect(markup).toContain("Move it to spam");
    expect(markup).toContain("Erase what it says");
    expect(markup).not.toContain("payload");
    expect(markup).not.toContain("JSON");
  });

  it("offers to accept a message that is currently held as spam", () => {
    const markup = render("suspected_spam");

    expect(markup).toContain("Not spam — accept it");
    expect(markup).not.toContain("Move it to spam");
  });
});
