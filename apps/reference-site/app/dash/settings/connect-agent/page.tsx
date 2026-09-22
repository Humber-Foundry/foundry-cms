import { Fragment } from "react";

import { notFound } from "next/navigation";

import { mcpSupportedScopes } from "@humber-foundry/application";

import { CopyAddressButton } from "@/components/copy-address-button";
import { DashboardBackLink } from "@/components/dashboard-back-link";
import { McpConnectionControls } from "@/components/mcp-connection-controls";
import {
  loadMutationToken,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { mcpAgentCapabilityDescriptions, mcpAgentNeverDoes } from "@/src/mcp-agent-capabilities";
import { mcpScopeDisplay } from "@/src/mcp-connection-display";
import {
  mcpChatGptInstructions,
  mcpClaudeAiInstructions,
  mcpClaudeCodeInstructions,
  mcpClientInstructionsSourcesReadOn,
  type McpClientInstructions,
} from "@/src/mcp-client-instructions";
import {
  loadMcpAgentConnectionInfo,
  loadMcpConnectionsForDashboard,
} from "@/src/mcp-dashboard-runtime";

export const dynamic = "force-dynamic";

function ClientSteps({ instructions }: { instructions: McpClientInstructions }) {
  return (
    <div className="agent-client-steps">
      <h3>{instructions.client}</h3>
      <p>{instructions.note}</p>
      <ol>
        {instructions.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="agent-client-sources">
        {/* Each link stays a direct child of this paragraph, with the
            surrounding sentence as its sibling text, so it counts as a link
            inline in a sentence — exempt from the standalone minimum tap
            target under WCAG 2.2 SC 2.5.8 — rather than a standalone control
            with nothing else in its own parent element. */}
        Steps for {instructions.client}, read from{" "}
        {instructions.sourceUrls.map((url, index) => (
          <Fragment key={url}>
            {index > 0 ? ", " : ""}
            <a href={url} target="_blank" rel="noreferrer">
              {new URL(url).hostname}
            </a>
          </Fragment>
        ))}{" "}
        on {mcpClientInstructionsSourcesReadOn}. Foundry has not tested a live
        connection against {instructions.client}, so treat these as steps to
        follow, not a guarantee of an exact screen.
      </p>
    </div>
  );
}

/**
 * The one screen an Owner needs to connect an AI agent: the site's real
 * address, what a connected agent can and cannot do in plain words, the
 * published steps for Claude and ChatGPT, and the list of connections
 * already approved.
 *
 * The address is built from this installation's real configured origin
 * (`loadMcpAgentConnectionInfo`), never hard-coded, and it is not a secret.
 * This screen never shows a token, a client secret or a personal address.
 */
export default async function ConnectAgentPage() {
  const access = await requireAuthorizedDashboardAccess();
  if (access.membership.role !== "owner") {
    notFound();
  }

  const mutationToken = await loadMutationToken();
  const mcpConnections = await loadMcpConnectionsForDashboard();
  const connectionInfo = await loadMcpAgentConnectionInfo();

  return (
    <main className="dashboard-main" id="main">
      {/* This screen is reached from Settings' Connected agents tab, so it
          names that tab rather than Settings as a whole (#240). #227 adds the
          rest of the dashboard's back links. */}
      <DashboardBackLink
        href="/dash/settings/agents"
        label="Back to Connected agents"
      />
      <div className="page-heading">
        <div>
          <h1>Connect an AI agent</h1>
          <p>
            Give an AI agent, such as Claude or ChatGPT, its own limited
            connection to this site. Nothing is pasted here — you approve the
            connection by signing in when the agent asks.
          </p>
        </div>
      </div>

      {connectionInfo.resourceUri === null ? (
        <section className="empty-state" aria-labelledby="agent-address">
          <h2 id="agent-address">This installation has no site address set</h2>
          <p>
            Ask whoever manages hosting to set this site&rsquo;s address before
            an agent can connect.
          </p>
        </section>
      ) : (
        <section aria-labelledby="agent-address">
          <h2 id="agent-address">Your site&rsquo;s agent address</h2>
          <p>
            Paste this address into the agent&rsquo;s connector settings. It is
            not a secret, but it is specific to this site.
          </p>
          <div className="agent-address-row">
            <code>{connectionInfo.resourceUri}</code>
            <CopyAddressButton value={connectionInfo.resourceUri} />
          </div>
          {connectionInfo.reachableFromOutsideThisMachine ? null : (
            <p className="empty-state">
              This address is not reachable from outside this machine right
              now. It looks like a local development copy or a private
              preview. Claude and ChatGPT run in their own cloud and must
              reach this site over the public internet, so connecting will
              not work until this site has a public HTTPS address.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="agent-can">
        <h2 id="agent-can">What you can allow it to do</h2>
        <p>
          Every connection starts with the first permission below. You choose
          whether to add any of the others when you approve the connection,
          and you can change your mind later by revoking the connection.
        </p>
        <ul className="agent-capability-list">
          {mcpSupportedScopes.map((scope) => (
            <li key={scope}>
              <strong>{mcpScopeDisplay(scope).phrase}</strong>
              <p>{mcpAgentCapabilityDescriptions[scope]}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="agent-cannot">
        <h2 id="agent-cannot">What it can never do</h2>
        <ul className="agent-capability-list">
          {mcpAgentNeverDoes.map((statement) => (
            <li key={statement}>{statement}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="connect-claude">
        <h2 id="connect-claude">Steps for Claude</h2>
        <ClientSteps instructions={mcpClaudeAiInstructions} />
        <ClientSteps instructions={mcpClaudeCodeInstructions} />
      </section>

      <section aria-labelledby="connect-chatgpt">
        <h2 id="connect-chatgpt">Steps for ChatGPT</h2>
        <ClientSteps instructions={mcpChatGptInstructions} />
      </section>

      <section aria-labelledby="agent-connections">
        <h2 id="agent-connections">Your connections</h2>
        <p>
          Every connection you approve appears here at once, with when it was
          last used and a button to revoke it.
        </p>
        <McpConnectionControls
          connections={mcpConnections}
          csrfToken={mutationToken}
        />
      </section>
    </main>
  );
}
