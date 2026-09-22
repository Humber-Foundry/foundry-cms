"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * A small picture of the site, drawn from the site itself.
 *
 * The page inside is laid out at a desktop width and then shrunk to whatever
 * room the card has, so the picture shows the site the way a reader on a
 * computer sees it rather than a squeezed phone layout. `zoom` shrinks the
 * laid-out box as well as the paint, so the frame's own height follows.
 *
 * `/dash/design` scales its large live preview the same way. That one fills a
 * column beside the controls and is scrolled; this one is a fixed picture in
 * a card, cropped at the bottom by its frame.
 *
 * The picture is not a second copy of the site to read or operate. It is
 * hidden from assistive technology and takes no keyboard focus; the card's
 * own address link opens the real site.
 */
export function SitePreviewFrame({
  layoutWidth,
  children,
}: {
  /** The width the site is laid out at before it is shrunk, in pixels. */
  layoutWidth: number;
  /** The rendered site. Built on the server and passed in. */
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  // A card in the dashboard grid is about this wide, so the first paint is
  // already close and the picture does not jump when the width is measured.
  const [scale, setScale] = useState(0.22);

  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setScale(width / layoutWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layoutWidth]);

  return (
    <div className="dash-site-preview" ref={frame}>
      <div
        className="dash-site-preview-page"
        style={
          {
            "--dash-preview-scale": scale,
            "--dash-preview-width": `${layoutWidth}px`,
          } as CSSProperties
        }
        aria-hidden="true"
        inert
      >
        {children}
      </div>
    </div>
  );
}
