"use client";

import { useEffect, useState } from "react";

import { HelpTip } from "./help-tip";

/**
 * What is connected: email delivery, site publishing, or the sender details
 * and compliance footer that go at the bottom of every email.
 */
export type ConnectionKind = "email" | "publishing" | "senderDetails";

/**
 * Where this public repository's own documents are read from, so a setup
 * guide's path can become a real link. One constant, so an installation that
 * forks or mirrors this repository changes its documentation address in one
 * place.
 */
const documentationBaseAddress =
  "https://github.com/Humber-Foundry/foundry-cms/blob/main/";

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

/**
 * Everything this component says about one kind, gathered in one place.
 *
 * One entry per kind, so adding a kind is one edit rather than an edit to
 * each sentence map.
 *
 * `connectedMeaning`: "connected" means the settings a send or a publish needs
 * are present. No report calls the provider to prove a working connection, so
 * the plain sentence shows by default and the fuller explanation sits behind a
 * `HelpTip` (#149) rather than on every screen that renders it.
 *
 * `settingNamesShownInline`: email and publishing are connected by an operator
 * who reads the setting names, and ADR-0021 puts them on the line. The sender
 * details are the owner's own words — a name and a postal address — so that
 * line says it in plain words and keeps the names behind a disclosure for
 * whoever installs them.
 */
type ConnectionCopy = Readonly<{
  setupLinkLabel: string;
  localDevelopmentSentence: string;
  connectedSentence: string;
  notConnectedSentence: string;
  connectedMeaning: string;
  settingNamesShownInline: boolean;
}>;

/**
 * What the owner reads when the sender details are absent.
 *
 * Exported because the Newsletter steps refuse with the same reason and must
 * say the same words. One sentence, one place.
 */
export const senderDetailsNotSetSentence =
  "Foundry does not yet have the name and postal address that must appear " +
  "at the bottom of every email, so no campaign can be written or sent.";

const connectionCopy: Readonly<Record<ConnectionKind, ConnectionCopy>> = {
  email: {
    setupLinkLabel: "How to connect email",
    localDevelopmentSentence:
      "Email is off in local development, because this site holds no email " +
      "provider connection.",
    connectedSentence: "Email is connected.",
    notConnectedSentence: "Email is not connected yet.",
    connectedMeaning:
      "This means every email setting is installed, not that a message was " +
      "sent.",
    settingNamesShownInline: true,
  },
  publishing: {
    setupLinkLabel: "How to connect publishing",
    localDevelopmentSentence: "Publishing is off in local development.",
    connectedSentence: "Publishing is connected.",
    notConnectedSentence: "Publishing is not connected yet.",
    connectedMeaning:
      "This means every publishing setting is installed, not that GitHub or " +
      "Cloudflare were reached.",
    settingNamesShownInline: true,
  },
  senderDetails: {
    setupLinkLabel: "How to set the sender details",
    localDevelopmentSentence:
      "Local development uses a footer marked as local development, and " +
      "nothing it writes can be sent.",
    connectedSentence: "Your sender details are set.",
    notConnectedSentence: senderDetailsNotSetSentence,
    connectedMeaning:
      "This means the name, postal address, contact page and unsubscribe " +
      "page for the bottom of every email are set, and Foundry knows which " +
      "address the email comes from.",
    settingNamesShownInline: false,
  },
};

const helpTipLabel = "What does connected mean?";
const settingNamesLabel = "Which settings are these?";

/**
 * Whether email delivery, site publishing, or the sender details and
 * compliance footer are connected, in plain words.
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

  const copy = connectionCopy[kind];

  const missingNames = readiness.missingSettings.join(", ");
  const namesInline =
    readiness.missingSettings.length > 0 && copy.settingNamesShownInline;
  const namesBehindDisclosure =
    readiness.missingSettings.length > 0 && !copy.settingNamesShownInline;

  // Local development names no setting on screen. Nothing is absent that
  // anybody here has to install, so a list of configuration names would be
  // words a site owner cannot use. The setup document behind the link holds
  // them for whoever connects a real site.
  if (readiness.state === "local_development") {
    return (
      <p className="connection-status">
        {copy.localDevelopmentSentence}
        {copy.settingNamesShownInline ? (
          <>
            {" "}
            <a
              href={`${documentationBaseAddress}${readiness.setupGuide}`}
              target="_blank"
              rel="noreferrer"
            >
              {copy.setupLinkLabel}
            </a>
          </>
        ) : null}
      </p>
    );
  }

  if (readiness.state === "connected") {
    return (
      <p className="connection-status connection-status-connected">
        {copy.connectedSentence}{" "}
        <HelpTip label={helpTipLabel}>{copy.connectedMeaning}</HelpTip>
      </p>
    );
  }

  return (
    <p className="connection-status connection-status-missing" role="alert">
      {copy.notConnectedSentence}
      {namesInline ? <> Missing: {missingNames}.</> : null}
      {namesBehindDisclosure ? (
        <>
          {" "}
          <HelpTip label={settingNamesLabel}>
            {`Whoever set this site up installs them as ${missingNames}.`}
          </HelpTip>
        </>
      ) : null}{" "}
      <a
        href={`${documentationBaseAddress}${readiness.setupGuide}`}
        target="_blank"
        rel="noreferrer"
      >
        {copy.setupLinkLabel}
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
