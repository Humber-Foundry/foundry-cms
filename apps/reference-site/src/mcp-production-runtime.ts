import {
  createContentActorId,
  createInMemoryPublishedSiteRepository,
  createMcpAnalyticsApplication,
  createMcpBlogApplication,
  createMcpCampaignApplication,
  createMcpContentActorId,
  createMcpDraftApplication,
  createMcpPublicationApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  isMediaContentType,
  McpMediaValidationError,
  McpReadError,
  MediaMutationInProgressError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  type McpConnectionPrincipal,
  type McpMediaAsset,
  type MediaAsset,
} from "@humber-foundry/application";

import {
  createBlogPostId,
  mediaImageSrc,
} from "@humber-foundry/site-definition";

import {
  createMediaAssetId,
  createMediaOccurrenceId,
} from "@humber-foundry/application";

import { inspectImageSource } from "./image-source-metadata";

import { installedSiteDefinition } from "../foundry/site-definition";
import { installedPageComponentRegistry } from "../foundry/page-components";

import { createMcpAnalyticsRuntime } from "./mcp-analytics-runtime";
import { createMcpCampaignRuntime } from "./mcp-campaign-runtime";

import { authenticateCloudflareAccessIdentity } from "./access-authentication";
import { createD1HumanAccessStore } from "./d1-human-access-store";
import { createD1McpConnectionStore } from "./d1-mcp-connection-store";
import { createD1McpPreviewStore } from "./d1-mcp-preview-store";
import {
  archiveBlogPostWithWithdrawal,
  loadBlogPostOperationsApplication,
  restoreArchivedBlogPostAsDraft,
} from "./blog-post-operations-runtime";
import { createD1BlogPostOperationsStore } from "./d1-blog-post-operations-store";
import { createD1MediaAssetStore } from "./d1-media-asset-store";
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

/**
 * The photo id one upload mints.
 *
 * It is made from this site, this connection's own actor id and the retry key
 * the agent sent, so a retry after an unknown result mints the same id and
 * leaves one photo, not two. An agent never chooses a photo's id.
 */
export async function mcpMediaAssetId(
  principal: McpConnectionPrincipal,
  idempotencyKey: string,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${principal.siteId}:${principal.actorId}:${idempotencyKey}`,
    ),
  );
  return createMediaAssetId(
    `asset_${[...new Uint8Array(digest)]
      .slice(0, 16)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`,
  );
}

/**
 * The retry key the media library stores this request under. The library asks
 * for at least eight characters, and marking the key as an agent's keeps an
 * agent's retry apart from a person's.
 */
function mcpMediaMutationKey(idempotencyKey: string) {
  return `mcp-media-${idempotencyKey}`;
}

/** One photo, as an MCP tool reports it. */
function mcpMediaAssetOf(asset: MediaAsset): McpMediaAsset {
  return {
    assetId: asset.assetId,
    // The one place this site's media address is built, so a photo the tool
    // names and a photo the renderer serves are the same address.
    mediaPath: mediaImageSrc(asset.assetId),
    fileName: asset.fileName,
    contentType: asset.contentType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
  };
}

/**
 * Turn a refusal the media library raised into one an agent can act on.
 *
 * A rule the library keeps becomes a validation refusal with a named cause.
 * Losing the library's short mutation lease is not a rule at all, so it
 * becomes a retryable refusal rather than one that reads as a permission
 * problem. Anything else is left alone and reported as the failure it is.
 */
function mediaLibraryRefusal(error: unknown, fallbackReason: string) {
  if (error instanceof McpMediaValidationError) return error;
  if (error instanceof MediaValidationError) {
    return new McpMediaValidationError(
      fallbackReason,
      "The media library refused that photo.",
    );
  }
  if (error instanceof MediaOccurrenceConflictError) {
    return new McpMediaValidationError(
      "media_place_conflict",
      "Another change moved that photo slot. Read the draft again and retry.",
    );
  }
  if (
    error instanceof MediaMutationInProgressError ||
    error instanceof MediaSiteAccessError
  ) {
    // The media library raises the first when another change holds its short
    // mutation lease, and the second both for a photo of another site and for
    // a lease it could not renew. Every one of those is either transient or
    // already refused earlier by the tool's own checks, so the refusal
    // invites a retry rather than telling an agent to stop. The dashboard's
    // own route answers the same errors with 409 and a retry.
    return new McpReadError(
      "TEMPORARILY_UNAVAILABLE",
      "The photo library could not finish that request. Try the same request again.",
    );
  }
  return error;
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
    pageComponents: installedPageComponentRegistry,
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
      async mediaLibraryHoldsAsset({ assetId }) {
        // An address can name anything after `/api/media/`. A name this
        // site could never have given a photo is simply not one of its
        // photos, so it answers no rather than failing the request.
        let mediaAssetId;
        try {
          mediaAssetId = createMediaAssetId(assetId);
        } catch {
          return false;
        }
        return (
          (await createD1MediaAssetStore(database).getAsset(
            installedSiteDefinition.site.id,
            mediaAssetId,
          )) !== null
        );
      },
      async listMediaAssets({ principal }) {
        const assets = await createD1MediaAssetStore(database).listAssets(
          principal.siteId,
        );
        return assets.map(mcpMediaAssetOf);
      },
      async uploadMediaAsset({
        principal,
        fileName,
        source,
        idempotencyKey,
      }) {
        // The very same upload command the dashboard's own upload runs, with
        // the picture's real type and size read from the bytes themselves.
        // Nothing here is a second, looser upload path. See ADR-0037.
        let metadata;
        try {
          metadata = await inspectImageSource(source);
        } catch {
          throw new McpMediaValidationError(
            "media_not_an_image",
            "That file is not a JPEG, PNG or WebP picture.",
          );
        }
        if (!isMediaContentType(metadata.contentType)) {
          throw new McpMediaValidationError(
            "media_not_an_image",
            "This site stores JPEG, PNG and WebP photos only.",
          );
        }
        const { loadMediaAssetApplication } = await import(
          "./media-asset-runtime"
        );
        const application = await loadMediaAssetApplication(
          createMcpContentActorId(principal),
        );
        try {
          const asset = await application.commands.upload({
            actorId: createMcpContentActorId(principal),
            assetId: await mcpMediaAssetId(principal, idempotencyKey),
            fileName,
            contentType: metadata.contentType,
            byteLength: source.byteLength,
            width: metadata.width,
            height: metadata.height,
            source,
            idempotencyKey: mcpMediaMutationKey(idempotencyKey),
          });
          return mcpMediaAssetOf(asset);
        } catch (error) {
          throw mediaLibraryRefusal(error, "media_upload_refused");
        }
      },
      async placeMediaOccurrence({
        principal,
        workspaceId,
        occurrenceId,
        assetId,
        idempotencyKey,
      }) {
        const actorId = createMcpContentActorId(principal);
        const { loadMediaAssetApplication } = await import(
          "./media-asset-runtime"
        );
        const application = await loadMediaAssetApplication(actorId);
        const asset = await application.queries.getAsset(
          createMediaAssetId(assetId),
        );
        if (asset === null) {
          throw new McpMediaValidationError(
            "media_asset_not_found",
            "This site holds no photo with that id.",
          );
        }
        const head = await application.queries.getOccurrence(
          workspaceId,
          createMediaOccurrenceId(occurrenceId),
        );
        try {
          const placed = await application.commands.replaceOccurrence({
            actorId,
            workspaceId,
            occurrenceId: createMediaOccurrenceId(occurrenceId),
            assetId: createMediaAssetId(assetId),
            baseRevision: head?.revision ?? 0,
            idempotencyKey: mcpMediaMutationKey(idempotencyKey),
          });
          return {
            occurrenceId: placed.occurrenceId,
            revision: placed.revision,
            asset: {
              assetId: asset.assetId,
              width: asset.width,
              height: asset.height,
              contentType: asset.contentType,
            },
          };
        } catch (error) {
          throw mediaLibraryRefusal(error, "media_place_refused");
        }
      },
      cursors,
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
  const blogApplication = createMcpBlogApplication({
    base: readApplication,
    runtime: {
      findPost({ postId }) {
        return createD1BlogPostOperationsStore(database).findPost(
          installedSiteDefinition.site.id,
          postId,
        );
      },
      archivePost(input) {
        return archiveBlogPostWithWithdrawal({
          environment,
          actorId: createContentActorId(input.actorId),
          postId: createBlogPostId(input.postId),
          selectedPostRevisionId: input.selectedPostRevisionId,
          idempotencyKey: input.idempotencyKey,
          authority: input.authority,
        });
      },
      restorePost(input) {
        return restoreArchivedBlogPostAsDraft({
          environment,
          actorId: createContentActorId(input.actorId),
          postId: createBlogPostId(input.postId),
          selectedPostRevisionId: input.selectedPostRevisionId,
          idempotencyKey: input.idempotencyKey,
          authority: input.authority,
        });
      },
      async requestSchedule(input) {
        const operations =
          await loadBlogPostOperationsApplication(environment);
        return operations.commands.proposeSchedule({
          actorId: createContentActorId(input.actorId),
          siteId: installedSiteDefinition.site.id,
          postId: createBlogPostId(input.postId),
          resolvedTime: input.resolvedTime,
          idempotencyKey: input.idempotencyKey,
          authority: input.authority,
        });
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
      blogApplication,
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
