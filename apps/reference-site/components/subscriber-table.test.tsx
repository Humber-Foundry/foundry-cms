import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscriberTable } from "./subscriber-table";

describe("SubscriberTable", () => {
  it("says in plain words that nobody has joined yet", () => {
    const markup = renderToStaticMarkup(
      <SubscriberTable rows={[]} labelledBy="subscriber-list" />,
    );
    expect(markup).toContain("Nobody has joined your list yet");
    expect(markup).not.toContain("<table");
  });

  it("lists one row per subscriber with the address, the state and the consent date", () => {
    const markup = renderToStaticMarkup(
      <SubscriberTable
        rows={[
          {
            id: "subscriber-1",
            email: "person@example.com",
            displayState: "confirmed",
            consentDate: "2026-01-01T00:00:00.000Z",
          },
        ]}
        labelledBy="subscriber-list"
      />,
    );
    expect(markup).toContain("person@example.com");
    expect(markup).toContain("Confirmed");
    expect(markup).toContain('aria-labelledby="subscriber-list"');
  });

  it("shows a removed address in plain words, never the word null", () => {
    const markup = renderToStaticMarkup(
      <SubscriberTable
        rows={[
          {
            id: "subscriber-1",
            email: null,
            displayState: "suppressed",
            consentDate: "2026-01-01T00:00:00.000Z",
          },
        ]}
        labelledBy="subscriber-list"
      />,
    );
    expect(markup).toContain("Address removed");
    expect(markup).not.toContain("null");
  });
});
