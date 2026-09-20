/**
 * The plain pages a member of the public reaches from a newsletter message.
 *
 * Unsubscribing and confirming a signup both answer with a small HTML page and
 * no JavaScript, so they work in any mail client's browser. Both use this one
 * builder, so the headers that keep those pages out of caches and out of
 * referrer strings cannot be set on one page and forgotten on the other.
 */
export function newsletterPublicPage({
  title,
  body,
  status = 200,
}: {
  title: string;
  body: string;
  status?: number;
}) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width">` +
      `<title>${escapeText(title)}</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // These pages are reached from a link in somebody's mailbox. They must
        // not be kept by a cache, and the address of the page must not be
        // passed on to anywhere it links to.
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Makes a value safe to place inside a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string) {
  return escapeText(value).replaceAll('"', "&quot;");
}
