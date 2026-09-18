import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HelpTip } from "./help-tip";

describe("HelpTip, initial markup", () => {
  it("renders a closed button with no panel in the document", () => {
    const markup = renderToStaticMarkup(
      <HelpTip label="What's a revision?">
        A revision is a saved version of your content.
      </HelpTip>,
    );

    expect(markup).toContain('aria-label="What&#x27;s a revision?"');
    expect(markup).toContain('aria-expanded="false"');
    // Nothing describes the button until it opens — a hidden panel referenced
    // by id would still be announced by some screen readers, so the closed
    // state renders no panel and no aria-describedby at all.
    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain("A revision is a saved version");
  });
});
