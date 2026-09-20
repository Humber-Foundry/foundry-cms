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

import { installedSiteDefinition } from "../foundry/site-definition";

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
import { isValidMcpRedirectUri } from "./mcp-client-registration";
import {
  createMcpHttpRuntime,
  createSignedMcpCursorCodec,
} from "./mcp-http-runtime";
import { mcpResourcePath } from "./mcp-resource-path";
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

const resourcePath = mcpResourcePath;
const tokenPath = `${resourcePath}/oauth/token`;
const registrationPath = `${resourcePath}/oauth/register`;
const protectedResourceMetadataPath =
  `/.well-known/oauth-protected-resource${resourcePath}`;
const authorizationServerMetadataPath =
  "/.well-known/oauth-authorization-server";
const authorizationPath = "/api/foundry-cms/mcp/oauth/authorize";
const revocationPath = "/api/foundry-cms/mcp-connections/revoke";

/**
 * Which MCP paths a Cloudflare Access application must let through, and which
 * it must keep protected.
 *
 * An MCP client calls the public paths with no human present and no Access
 * session. If the Access application covers them, Access answers with its own
 * sign-in page and the client cannot discover, register or exchange a token.
 *
 * The Owner paths must stay behind Access. Consent and revocation are the
 * human decisions that turn a registration into real access.
 */
export const mcpAccessBoundary = Object.freeze({
  public: Object.freeze([
    protectedResourceMetadataPath,
    authorizationServerMetadataPath,
    registrationPath,
    tokenPath,
    resourcePath,
  ]),
  ownerProtected: Object.freeze([authorizationPath, revocationPath]),
});

/**
 * Report whether the MCP router and the documented Access boundary still agree.
 * A path the router serves but the boundary does not name would be an
 * undocumented hole; a named path the router does not serve would be a stale
 * instruction to the operator.
 */
export function checkMcpAccessBoundary(): Readonly<{
  ok: boolean;
  unroutedPaths: ReadonlyArray<string>;
  undocumentedPaths: ReadonlyArray<string>;
}> {
  const documented = [
    ...mcpAccessBoundary.public,
    ...mcpAccessBoundary.ownerProtected,
  ];
  const routed = [
    resourcePath,
    tokenPath,
    registrationPath,
    authorizationPath,
    revocationPath,
    authorizationServerMetadataPath,
    protectedResourceMetadataPath,
  ];
  const unroutedPaths = documented.filter((path) => !routed.includes(path));
  const undocumentedPaths = routed.filter(
    (path) => !documented.includes(path),
  );
  return {
    ok: unroutedPaths.length === 0 && undocumentedPaths.length === 0,
    unroutedPaths,
    undocumentedPaths,
  };
}

function requireSetting(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new HumanAccessConfigurationError();
  }
  return value;
}

/**
 * A redirect URI an operator may pin in the allowlist.
 *
 * This is stricter than the rule for a dynamically registered client: it does
 * not accept the `localhost` name. An operator writes these by hand and can
 * write the literal loopback address, which RFC 8252 section 8.3 prefers
 * because a name can be made to resolve elsewhere.
 */
function validRedirectUri(value: string) {
  return (
    isValidMcpRedirectUri(value) && new URL(value).hostname !== "localhost"
  );
}

/**
 * Read the operator's optional client allowlist.
 *
 * An unset or empty `FOUNDRY_MCP_CLIENTS` means the installation accepts
 * dynamic client registration, which is how claude.ai, ChatGPT and Claude Code
 * connect with nothing pasted by the Owner. Setting it turns registration off
 * and restricts authorization to the listed clients.
 */
export function readMcpRegisteredClients(
  value: string | undefined,
): Readonly<
  Record<
    string,
    Readonly<{ name: string; redirectUris: ReadonlyArray<string> }>
  >
> {
  if (value === undefined || value.trim() === "") {
    return Object.freeze({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
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
  // A present but empty allowlist is a configuration mistake, not a request
  // for open registration. Unset the variable to allow registration.
  if (Object.keys(clients).length === 0) {
    throw new HumanAccessConfigurationError();
  }
  return Object.freeze(clients);
}

export function isMcpProductionRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === resourcePath ||
    pathname === tokenPath ||
    pathname === registrationPath ||
    pathname === authorizationPath ||
    pathname === revocationPath ||
    pathname === authorizationServerMetadataPath ||
    pathname === protectedResourceMetadataPath
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
    siteId: installedSiteDefinition.site.id,
    publishedSites: createInMemoryPublishedSiteRepository([
      createPublishedSiteBundle(installedSiteDefinition),
    ]),
  });
  const readApplication = createMcpReadApplication({
    site,
    siteMetadata: {
      canonicalUrl: canonicalOrigin,
      locale: environment.FOUNDRY_SITE_LOCALE ?? "en-CA",
      timeZone: environment.FOUNDRY_SITE_TIME_ZONE ?? "America/Vancouver",
      getLiveRelease: () =>
        store.findLiveRelease(installedSiteDefinition.site.id),
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
      loadPreviewReview({ principal, previewId }) {
        return store.findPreviewReview({
          connectionId: principal.connectionId,
          siteId: principal.siteId,
          previewId,
        });
      },
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
    siteId: installedSiteDefinition.site.id,
    siteName: installedSiteDefinition.site.name,
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
    registrationPath,
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
        siteId: installedSiteDefinition.site.id,
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
