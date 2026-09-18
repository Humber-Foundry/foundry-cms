import { describe, expect, it } from "vitest";

import {
  mcpChatGptInstructions,
  mcpClaudeAiInstructions,
  mcpClaudeCodeInstructions,
} from "./mcp-client-instructions";

describe("MCP client instructions", () => {
  for (const instructions of [
    mcpClaudeAiInstructions,
    mcpClaudeCodeInstructions,
    mcpChatGptInstructions,
  ]) {
    it(`gives ${instructions.client} at least one cited source and one step`, () => {
      expect(instructions.steps.length).toBeGreaterThan(0);
      expect(instructions.sourceUrls.length).toBeGreaterThan(0);
      for (const url of instructions.sourceUrls) {
        expect(url).toMatch(/^https:\/\//);
      }
    });

    it(`never tells the Owner to paste a token value for ${instructions.client}`, () => {
      const text = instructions.steps.join(" ").toLowerCase();
      expect(text).not.toContain("paste your token");
      expect(text).not.toContain("paste the token");
      expect(text).not.toContain("api key");
    });
  }
});
