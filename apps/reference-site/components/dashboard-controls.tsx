"use client";

import { useState } from "react";
import type { SiteId } from "@humber-foundry/site-definition";

export const DASHBOARD_PRIVATE_BUNDLE_MARKER =
  "FOUNDRY_DASHBOARD_PRIVATE_CLIENT_BOUNDARY";

export function DashboardControls({ siteId }: { siteId: SiteId }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function copySiteId() {
    try {
      await navigator.clipboard.writeText(siteId);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="copy-control">
      <button
        className="copy-button"
        type="button"
        onClick={copySiteId}
        data-private-boundary={DASHBOARD_PRIVATE_BUNDLE_MARKER}
      >
        {copyState === "copied" ? "Site ID copied" : "Copy site ID"}
      </button>
      <span className="copy-status" aria-live="polite">
        {copyState === "failed"
          ? "Copy unavailable. Select the ID from the inventory."
          : ""}
      </span>
    </div>
  );
}
