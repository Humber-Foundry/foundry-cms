import {
  createAnalyticsQueryApplication,
  createAnalyticsQueryCache,
  type AnalyticsQueryCache,
  type McpAnalyticsRuntime,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1AnalyticsStore } from "./d1-analytics-store";
import {
  HumanAccessConfigurationError,
  type HumanAccessEnvironment,
} from "./human-access-configuration";

/**
 * The MCP analytics view is the same bounded aggregate projection `/dash`
 * reads. The scope was already checked at the tool boundary, so the query
 * application authorizes every read here without a second capability lookup,
 * exactly as the dashboard context wires its own authorization.
 */
type McpAnalyticsActor = Readonly<{ kind: "mcp" }>;

const mcpAnalyticsActor: McpAnalyticsActor = Object.freeze({ kind: "mcp" });

/**
 * Held at module scope so answers persist between MCP requests in this isolate,
 * the same reason the dashboard holds its cache outside the per-request
 * application. Every cache key already includes the site id.
 */
const queryCache: AnalyticsQueryCache = createAnalyticsQueryCache();

export function createMcpAnalyticsRuntime({
  environment,
  reportingTimeZone,
  cache = queryCache,
}: {
  environment: HumanAccessEnvironment;
  reportingTimeZone: string;
  cache?: AnalyticsQueryCache;
}): McpAnalyticsRuntime {
  return {
    async read({ view, range, limit }) {
      const database = environment.FOUNDRY_DB;
      if (database === undefined) {
        throw new HumanAccessConfigurationError();
      }
      const siteId = referenceSiteDefinition.site.id;
      const application = createAnalyticsQueryApplication<McpAnalyticsActor>({
        siteId,
        store: createD1AnalyticsStore(database, siteId),
        reportingTimeZone,
        cache,
        authorize: async () => {},
      });
      const actor = mcpAnalyticsActor;
      const pageLimit = limit ?? undefined;
      switch (view) {
        case "overview":
          return application.queries.overview({ actor, range });
        case "content":
          return application.queries.content({ actor, range, limit: pageLimit });
        case "forms":
          return application.queries.forms({ actor, range });
        case "audience":
          return application.queries.audience({ actor, range });
        case "campaigns":
          return application.queries.campaigns({
            actor,
            range,
            limit: pageLimit,
          });
        case "health":
          return application.queries.health({ actor, range });
        default: {
          // The view is a fixed enum validated at the tool boundary. A new
          // view must add a case here rather than fall through to undefined.
          const unreachable: never = view;
          throw new Error(`unsupported_analytics_view:${String(unreachable)}`);
        }
      }
    },
  };
}
