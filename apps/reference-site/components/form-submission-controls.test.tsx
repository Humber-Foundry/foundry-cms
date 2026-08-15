import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FormSubmissionActions } from "./form-submission-controls";

describe("message actions", () => {
  it("names each action in plain words", () => {
    const markup = renderToStaticMarkup(
      <FormSubmissionActions classification="accepted" />,
    );

    expect(markup).toContain("What you can do with this message");
    expect(markup).toContain("Download a copy");
    expect(markup).toContain("Move it to spam");
    expect(markup).toContain("Erase what it says");
    expect(markup).not.toContain("payload");
    expect(markup).not.toContain("JSON");
  });

  it("offers to accept a message that is currently held as spam", () => {
    const markup = renderToStaticMarkup(
      <FormSubmissionActions classification="suspected_spam" />,
    );

    expect(markup).toContain("Not spam — accept it");
    expect(markup).not.toContain("Move it to spam");
  });
});
