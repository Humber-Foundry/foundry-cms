"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { campaignPreviewDocument } from "./campaign-operations";
import { HelpTip } from "./help-tip";

/**
 * The two widths a person reads the email at.
 *
 * 600 pixels is the width nearly every email is built to, so it is what the
 * email looks like on a computer. 390 pixels is a common phone screen. The
 * frame is set to the exact width, never scaled, so the lines break where they
 * will break in a real inbox.
 */
const previewWidths = Object.freeze({
  computer: Object.freeze({ label: "On a computer", pixels: 600 }),
  phone: Object.freeze({ label: "On a phone", pixels: 390 }),
});

type PreviewWidth = keyof typeof previewWidths;

/** How short and how tall the frame may be, in pixels. */
const shortestPreview = 240;
const tallestPreview = 900;

const previewWidthNames = Object.freeze(
  Object.keys(previewWidths) as ReadonlyArray<PreviewWidth>,
);

/**
 * The email exactly as it will arrive, at a width the person chooses.
 *
 * The frame draws the very bytes the campaign renderer produces and the
 * delivery provider sends, not a second drawing of the same content in the
 * dashboard's own styles. That is the whole point: two drawings can disagree,
 * and only one of them is posted.
 *
 * The frame is sandboxed and carries its own content security policy, so it
 * runs no script, opens no popup, follows no link and loads nothing from off
 * this site. See `campaignPreviewDocument` and ADR-0046.
 */
export function CampaignEmailPreview({
  html,
  text,
  contentId,
}: {
  /** The rendered email HTML, exactly as the report returned it. */
  html: string;
  /**
   * The rendered plain-text email, or null while the report has not been read
   * yet. The text and the Content ID both sit behind the disclosure.
   */
  text: string | null;
  /** The HTML artifact's fingerprint, or null while it is not known. */
  contentId: string | null;
}) {
  const [width, setWidth] = useState<PreviewWidth>("computer");
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(shortestPreview);

  /**
   * Make the frame as tall as the email in it.
   *
   * A short email in a tall box reads as an unfinished screen, and a long one
   * in a short box hides most of itself. The frame has this site's own origin,
   * so the height of the email inside it can be read. A very long email stops
   * at `tallestPreview` and scrolls from there, so one email cannot push the
   * sending steps off the screen.
   */
  const fitToEmail = useCallback(() => {
    const inside = frame.current?.contentDocument;
    if (inside === null || inside === undefined) return;
    setHeight(
      Math.min(
        Math.max(inside.documentElement.scrollHeight + 2, shortestPreview),
        tallestPreview,
      ),
    );
  }, []);

  // The frame does not load again when the width changes, so the height is
  // measured again after the browser has laid the email out at the new width.
  useEffect(() => {
    const frameRequest = requestAnimationFrame(fitToEmail);
    return () => cancelAnimationFrame(frameRequest);
  }, [fitToEmail, width, html]);

  return (
    <section className="email-preview" aria-label="Email preview">
      <div className="email-preview-head">
        <h2>How the email looks</h2>
        <div
          className="email-preview-widths"
          role="group"
          aria-label="Read it at this width"
        >
          {previewWidthNames.map((name) => (
            <button
              key={name}
              type="button"
              className="dash-button dash-button-plain email-preview-width"
              aria-pressed={width === name}
              onClick={() => setWidth(name)}
            >
              {previewWidths[name].label}
            </button>
          ))}
        </div>
      </div>
      <div className="email-preview-frame">
        <iframe
          ref={frame}
          title="The email as it will arrive"
          className="email-preview-page"
          style={{
            width: `${previewWidths[width].pixels}px`,
            height: `${height}px`,
          }}
          onLoad={fitToEmail}
          // No `allow-scripts`, so nothing in the email can run. No
          // `allow-popups`, so a press on a link opens nothing.
          // `allow-same-origin` is what lets the policy's `img-src 'self'`
          // name this site; without it the frame has no origin of its own and
          // the email's pictures would not draw at all.
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={campaignPreviewDocument(html)}
        />
      </div>
      {text === null || contentId === null ? null : (
        <details>
          <summary>How the email reads, and technical details</summary>
          <pre>{text}</pre>
          <p>
            Content ID{" "}
            <HelpTip label="What's a Content ID?">
              A code that proves this email's exact content, so support can
              confirm nothing changed after it was approved.
            </HelpTip>
            : <code>{contentId}</code>
          </p>
        </details>
      )}
    </section>
  );
}
