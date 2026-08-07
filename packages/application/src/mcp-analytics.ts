import { AnalyticsRangeError } from "./analytics-queries";
import {
  McpReadError,
  mcpAnalyticsReadScope,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type McpReadAuditEvent,
} from "./mcp-read";

export const mcpAnalyticsViews = Object.freeze([
  "overview",
  "content",
  "forms",
  "audience",
  "campaigns",
  "health",
] as const);

export type McpAnalyticsView = (typeof mcpAnalyticsViews)[number];

export type McpAnalyticsRange = Readonly<{
  fromLocalDate: string;
  toLocalDate: string;
}>;

/**
 * The analytics query application answers only fixed bounded views over the
 * aggregate projection. The runtime dispatches one named view and returns its
 * view object unchanged; the projection has already applied metric metadata,
 * small-cell suppression, and comparability. The MCP layer adds no query
 * shape of its own, so an agent cannot widen a view or reach raw facts.
 */
export type McpAnalyticsRuntime = Readonly<{
  read(input: {
    principal: McpConnectionPrincipal;
    view: McpAnalyticsView;
    range: McpAnalyticsRange;
    limit: number | null;
  }): Promise<unknown>;
}>;

type McpAnalyticsApplicationBase = Readonly<{
  executeScoped<Result>(input: {
    principal: McpConnectionPrincipal;
    operation: string;
    auditInput: unknown;
    requiredScopes: ReadonlyArray<string>;
    context: McpExecutionContext;
    run(
      context: McpExecutionContext,
      audit: McpReadAuditEvent,
    ): Promise<Result>;
  }): Promise<unknown>;
}>;

function analyticsError(error: unknown): McpReadError {
  if (error instanceof McpReadError) return error;
  if (error instanceof AnalyticsRangeError) {
    return new McpReadError(
      "VALIDATION_FAILED",
      "The analytics range is invalid.",
    );
  }
  // A projection, privacy, vocabulary or comparability guard failing must fail
  // closed rather than leak a partial payload, so it becomes an opaque
  // temporary error like any other unexpected fault.
  return new McpReadError(
    "TEMPORARILY_UNAVAILABLE",
    "The request could not be completed safely.",
  );
}

export function createMcpAnalyticsApplication({
  base,
  runtime,
}: {
  base: McpAnalyticsApplicationBase;
  runtime: McpAnalyticsRuntime;
}) {
  return Object.freeze({
    readAnalytics(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        view: McpAnalyticsView;
        range: McpAnalyticsRange;
        limit: number | null;
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.analytics.read",
        auditInput: input,
        requiredScopes: [mcpAnalyticsReadScope],
        context,
        async run(execution) {
          try {
            const view = await execution.run(() =>
              runtime.read({
                principal,
                view: input.view,
                range: input.range,
                limit: input.limit,
              }),
            );
            return { view: input.view, data: view };
          } catch (error) {
            throw analyticsError(error);
          }
        },
      });
    },
  });
}
