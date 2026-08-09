import {
  createInMemoryPublishedSiteRepository,
  createMcpAnalyticsApplication,
  createMcpCampaignApplication,
  createMcpContentActorId,
  createMcpDraftApplication,
  createMcpPublicationApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { createMcpAnalyticsRuntime } from "./mcp-analytics-runtime";
import { createMcpCampaignRuntime } from "./mcp-campaign-runtime";

import { authenticateCloudflareAccessIdentity } from "./access-authentication";
import { createD1HumanAccessStore } from "./d1-human-access-store";
import { createD1McpConnectionStore } from "./d1-mcp-connection-store";
import { createD1McpPreviewStore } from "./d1-mcp-preview-store";
import { loadBlogPostOperationsApplication } from "./blog-post-operations-runtime";
import { createContentPublicationApplicationForEnvironment } from "./content-publication-environment-runtime";
import {
  mcpPreviewReviewUrl,
  revisionPreviewGatewayUrl,
} from "./content-revision-links";
import {
  HumanAccessConfigurationError,
  readHumanMutationConfiguration,
  type HumanAccessEnvironment,
} from "./human-access-configuration";
import {
  createMcpHttpRuntime,
  createSignedMcpCursorCodec,
} from "./mcp-http-runtime";
import {
  createHumanCsrfToken,
  verifyHumanCsrfToken,
  verifyHumanMutationRequest,
} from "./human-request-integrity";

export type McpProductionEnvironment = HumanAccessEnvironment &
  Readonly<{
    FOUNDRY_MCP_OAUTH_SIGNING_KEY?: string;
    FOUNDRY_MCP_CLIENTS?: string;
    FOUNDRY_SITE_LOCALE?: string;
    FOUNDRY_SITE_TIME_ZONE?: string;
  }>;

const resourcePath = "/api/foundry-mcp";
const authorizationPath = "/api/foundry-cms/mcp/oauth/authorize";
const revocationPath = "/api/foundry-cms/mcp-connections/revoke";

function requireSetting(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new HumanAccessConfigurationError();
  }
  return value;
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return (
      !value.includes("*") &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
    );
  } catch {
    return false;
  }
}

export function readMcpRegisteredClients(
  value: string | undefined,
): Readonly<
  Record<
    string,
    Readonly<{ name: string; redirectUris: ReadonlyArray<string> }>
  >
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireSetting(value));
  } catch {
    throw new HumanAccessConfigurationError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new HumanAccessConfigurationError();
  }
  const clients: Record<
    string,
    Readonly<{ name: string; redirectUris: ReadonlyArray<string> }>
  > = {};
  for (const [clientId, metadata] of Object.entries(parsed)) {
    if (
      !validRedirectUri(clientId) ||
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      !("name" in metadata) ||
      typeof metadata.name !== "string" ||
      metadata.name.trim() === "" ||
      !("redirectUris" in metadata) ||
      !Array.isArray(metadata.redirectUris) ||
      metadata.redirectUris.length === 0 ||
      metadata.redirectUris.some(
        (redirect: unknown) =>
          typeof redirect !== "string" || !validRedirectUri(redirect),
      )
    ) {
      throw new HumanAccessConfigurationError();
    }
    clients[clientId] = Object.freeze({
      name: metadata.name,
      redirectUris: Object.freeze([
        ...(metadata.redirectUris as ReadonlyArray<string>),
      ]),
    });
  }
  if (Object.keys(clients).length === 0) {
    throw new HumanAccessConfigurationError();
  }
  return Object.freeze(clients);
}

export function isMcpProductionRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === resourcePath ||
    pathname === `${resourcePath}/oauth/token` ||
    pathname === authorizationPath ||
    pathname === revocationPath ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname ===
      `/.well-known/oauth-protected-resource${resourcePath}`
  );
}

export function createProductionMcpRuntime(
  environment: McpProductionEnvironment,
  context?: Readonly<{ waitUntil(promise: Promise<unknown>): void }>,
) {
  const canonicalOrigin = requireSetting(
    environment.FOUNDRY_CANONICAL_ORIGIN,
  );
  const database = environment.FOUNDRY_DB;
  if (database === undefined) {
    throw new HumanAccessConfigurationError();
  }
  const signingSecret = requireSetting(
    environment.FOUNDRY_MCP_OAUTH_SIGNING_KEY,
  );
  if (signingSecret.length < 32) {
    throw new HumanAccessConfigurationError();
  }
  const store = createD1McpConnectionStore(database);
  const cursors = createSignedMcpCursorCodec({ secret: signingSecret });
  const site = createSiteApplication({
    siteId: referenceSiteDefinition.site.id,
    publishedSites: createInMemoryPublishedSiteRepository([
      createPublishedSiteBundle(referenceSiteDefinition),
    ]),
  });
  const readApplication = createMcpReadApplication({
    site,
    siteMetadata: {
      canonicalUrl: canonicalOrigin,
      locale: environment.FOUNDRY_SITE_LOCALE ?? "en-CA",
      timeZone: environment.FOUNDRY_SITE_TIME_ZONE ?? "America/Vancouver",
      getLiveRelease: () =>
        store.findLiveRelease(referenceSiteDefinition.site.id),
    },
    connections: store,
    cursors,
  });
  const draftApplication = createMcpDraftApplication({
    base: readApplication,
    runtime: {
      ...createD1McpPreviewStore(database),
      async open({ actorId, idempotencyKey }) {
        const {
          contentWorkspaceIdForMutation,
          loadContentRevisionApplication,
        } = await import("./content-revision-runtime");
        return loadContentRevisionApplication(
          await contentWorkspaceIdForMutation(actorId, idempotencyKey),
          actorId,
        );
      },
      async load({ actorId, workspaceId }) {
        const { loadContentRevisionApplication } =
          await import("./content-revision-runtime");
        return loadContentRevisionApplication(
          workspaceId,
          actorId,
          environment,
        );
      },
      humanReviewUrl: (previewId) =>
        mcpPreviewReviewUrl(canonicalOrigin, previewId),
    },
  });
  const publicationApplication = createMcpPublicationApplication({
    base: readApplication,
    runtime: {
      async loadRevision({ principal, workspaceId }) {
        const { loadContentRevisionApplication } =
          await import("./content-revision-runtime");
        return loadContentRevisionApplication(
          workspaceId,
          createMcpContentActorId(principal),
          environment,
        );
      },
      loadPublication({ principal, workspaceId }) {
        return createContentPublicationApplicationForEnvironment(
          environment,
          workspaceId,
          createMcpContentActorId(principal),
        );
      },
      loadBlogOperations() {
        return loadBlogPostOperationsApplication(environment);
      },
      recordInvocation(event) {
        return store.recordPublicationInvocation(event);
      },
    },
  });
  const humanStore = createD1HumanAccessStore(database);
  const campaignApplication = createMcpCampaignApplication({
    base: readApplication,
    runtime: createMcpCampaignRuntime({ environment, humanStore }),
  });
  const analyticsApplication = createMcpAnalyticsApplication({
    base: readApplication,
    runtime: createMcpAnalyticsRuntime({
      environment,
      reportingTimeZone:
        environment.FOUNDRY_SITE_TIME_ZONE ?? "America/Vancouver",
    }),
  });
  return createMcpHttpRuntime({
    resourceUri: `${canonicalOrigin}${resourcePath}`,
    authorizationIssuer: canonicalOrigin,
    canonicalOrigin,
    signingSecret,
    siteId: referenceSiteDefinition.site.id,
    siteName: referenceSiteDefinition.site.name,
    store,
    readApplication: Object.assign(
      readApplication,
      draftApplication,
      publicationApplication,
      campaignApplication,
      analyticsApplication,
    ),
    cursors,
    registeredClients: readMcpRegisteredClients(
      environment.FOUNDRY_MCP_CLIENTS,
    ),
    defer: (promise) => context?.waitUntil(promise),
    authorizationPath,
    ownerRevocationPath: revocationPath,
    async authenticateOwner(request, intent) {
      const identity = await authenticateCloudflareAccessIdentity({
        requestHeaders: request.headers,
        environment,
      });
      const integrity = readHumanMutationConfiguration(environment);
      if (intent.mode === "mutate") {
        if (intent.csrfToken === null) {
          await verifyHumanMutationRequest({
            request,
            identity,
            audience: integrity.audience,
            canonicalOrigin: integrity.canonicalOrigin,
            secret: integrity.secret,
          });
        } else {
          if (
            request.headers.get("origin") !== integrity.canonicalOrigin
          ) {
            throw new HumanAccessConfigurationError();
          }
          await verifyHumanCsrfToken({
            token: intent.csrfToken,
            identity,
            audience: integrity.audience,
            secret: integrity.secret,
          });
        }
      }
      const membership = await humanStore.findMembershipByIdentity({
        siteId: referenceSiteDefinition.site.id,
        binding: identity.binding,
      });
      if (
        membership === null ||
        membership.status !== "active" ||
        membership.role !== "owner"
      ) {
        throw new HumanAccessConfigurationError();
      }
      return {
        membershipId: membership.id,
        ...(intent.mode === "view"
          ? {
              csrfToken: await createHumanCsrfToken({
                identity,
                audience: integrity.audience,
                secret: integrity.secret,
              }),
            }
          : {}),
      };
    },
  });
}
