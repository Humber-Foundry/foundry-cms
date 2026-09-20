"use client";

import { useState } from "react";

/**
 * Copies one plain value to the clipboard. Used for the site's MCP address,
 * which is not a secret, so showing and copying it plainly is safe.
 */
export function CopyAddressButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="copy-button" onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
