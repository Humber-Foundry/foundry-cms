"use client";

import { useEffect, useState } from "react";

/** What is connected: email delivery, or site publishing. */
export type ConnectionKind = "email" | "publishing";

/**
 * Where this public repository's own documents are read from, so a setup
 * guide's path can become a real link. One constant, so an installation that
 * forks or mirrors this repository changes its documentation address in one
 * place.
 */
const documentationBaseAddress =
  "https://github.com/Humber-Foundry/foundry-cms/blob/main/";

const setupLinkLabel: Readonly<Record<ConnectionKind, string>> = {
  email: "How to connect email",
  publishing: "How to connect publishing",
};

/**
 * How one installation's email delivery or site publishing is connected.
 * This is the shape both `CampaignDeliveryReadiness`
 * (`campaign-delivery-readiness.ts`) and `ContentPublicationReadiness`
 * (`content-publication-readiness.ts`) share on screen.
 *
 * `missingSettings` holds configuration names only. This is shown directly on
 * screen, so it must never carry a setting's value, a token, a key or a
 * personal address.
 */
export type ConnectionReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<string>;
  setupGuide: string;
}>;

const localDevelopmentSentence: Readonly<Record<ConnectionKind, string>> = {
  email: "Email is off in local development.",
  publishing: "Publishing is off in local development.",
};

const connectedSentence: Readonly<Record<ConnectionKind, string>> = {
  email: "Email is connected.",
  publishing: "Publishing is connected.",
};

const notConnectedSentence: Readonly<Record<ConnectionKind, string>> = {
  email: "Email is not connected yet.",
  publishing: "Publishing is not connected yet.",
};

/**
 * "Connected" here means the settings a send or a publish needs are present.
 * Neither report calls the provider to prove a working connection, so this
 * note stays next to every "connected" line rather than only in the setup
 * document.
 */
const connectedMeaning: Readonly<Record<ConnectionKind, string>> = {
  email:
    "This means every email setting is installed, not that a message was " +
    "sent.",
  publishing:
    "This means every publishing setting is installed, not that GitHub or " +
    "Cloudflare were reached.",
};

/**
 * Whether email delivery or site publishing is connected, in plain words.
 *
 * Shows the server's own state. It never assumes a connection exists because
 * a screen loaded, and it never renders a setting's value, so it is safe to
 * place on any screen a site owner reads.
 */
export function ConnectionStatus({
  kind,
  readiness,
}: {
  kind: ConnectionKind;
  readiness: ConnectionReadiness | null;
}) {
  // A screen this renders on can mock or omit the readiness fetch in tests
  // that are not about connection status, so this guards against any falsy
  // value, not only `null`.
  if (!readiness) return null;

  if (readiness.state === "local_development") {
    return (
      <p className="connection-status">{localDevelopmentSentence[kind]}</p>
    );
  }

  if (readiness.state === "connected") {
    return (
      <p className="connection-status connection-status-connected">
        {connectedSentence[kind]} {connectedMeaning[kind]}
      </p>
    );
  }

  return (
    <p className="connection-status connection-status-missing" role="alert">
      {notConnectedSentence[kind]}
      {readiness.missingSettings.length > 0 ? (
        <> Missing: {readiness.missingSettings.join(", ")}.</>
      ) : null}{" "}
      <a
        href={`${documentationBaseAddress}${readiness.setupGuide}`}
        target="_blank"
        rel="noreferrer"
      >
        {setupLinkLabel[kind]}
      </a>
    </p>
  );
}

/**
 * Site publishing readiness, fetched once when the screen holding it mounts.
 *
 * Blog, Pages and Settings each need this same fact but render inside
 * separate files, some of which other tickets are also changing. Fetching it
 * here keeps every call site to one import and one line, so this component
 * carries the fetch instead of repeating it in each screen.
 */
export function PublishingConnectionStatus() {
  const [readiness, setReadiness] = useState<ConnectionReadiness | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    void fetch("/api/foundry-cms/publishing-readiness", {
      headers: { accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { publishing?: ConnectionReadiness } | null) => {
        if (current && body?.publishing !== undefined) {
          setReadiness(body.publishing);
        }
      })
      .catch(() => {
        // A failed fetch leaves readiness unknown. The component renders
        // nothing rather than guess at a state the server never reported.
      });
    return () => {
      current = false;
    };
  }, []);

  return <ConnectionStatus kind="publishing" readiness={readiness} />;
}
