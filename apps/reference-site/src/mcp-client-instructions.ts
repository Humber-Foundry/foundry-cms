/**
 * Step-by-step instructions for connecting a real MCP client, read from each
 * client's own published documentation, not from memory. Foundry's own
 * conformance evidence (`docs/mcp/conformance.md`) is deterministic
 * repository evidence, not a claim that Claude, ChatGPT or Claude Code were
 * seen connecting to a live installation. Every step here is therefore
 * written as "steps for Claude" or "steps for ChatGPT" — steps to follow,
 * never a guarantee of an exact screen.
 *
 * Sources read on 2026-09-18:
 * - https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
 * - https://code.claude.com/docs/en/mcp
 * - https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
 * - https://developers.openai.com/api/docs/mcp
 */
export const mcpClientInstructionsSourcesReadOn = "18 September 2026";

export type McpClientInstructions = Readonly<{
  client: string;
  /** Shown under the heading, e.g. an account requirement. */
  note: string;
  steps: ReadonlyArray<string>;
  sourceUrls: ReadonlyArray<string>;
}>;

export const mcpClaudeAiInstructions: McpClientInstructions = {
  client: "Claude",
  note: "Needs a Claude account. A free account can add one connector; Pro, Max, Team and Enterprise accounts can add more than one.",
  steps: [
    "In claude.ai, open Settings, then Connectors.",
    "Select Add, then Custom connector.",
    "Paste this site's agent address below as the server URL. Leave the OAuth Client ID and OAuth Client Secret fields blank — this site registers the connection itself once you approve it.",
    "Continue, then sign in to Foundry as a site Owner when asked. Read the permissions and approve.",
  ],
  sourceUrls: [
    "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  ],
};

export const mcpClaudeCodeInstructions: McpClientInstructions = {
  client: "Claude Code",
  note: "Runs from a terminal. Needs the Claude Code CLI installed.",
  steps: [
    "Run: claude mcp add --transport http <a name you choose> <the address below>",
    "Claude Code opens your browser to sign in to Foundry as a site Owner and approve, the same as claude.ai.",
  ],
  sourceUrls: ["https://code.claude.com/docs/en/mcp"],
};

export const mcpChatGptInstructions: McpClientInstructions = {
  client: "ChatGPT",
  note: "Needs a ChatGPT Plus, Pro or Enterprise account. On a Team or Enterprise workspace, an admin must turn on Developer mode first.",
  steps: [
    "In ChatGPT, open Settings, then Connectors.",
    "Open Advanced settings and turn on Developer mode.",
    "Add a connector and paste this site's agent address below as the server URL.",
    "Sign in to Foundry as a site Owner when asked. Read the permissions and approve.",
  ],
  sourceUrls: [
    "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    "https://developers.openai.com/api/docs/mcp",
  ],
};
