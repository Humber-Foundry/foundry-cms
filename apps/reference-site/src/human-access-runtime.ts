import "server-only";

import {
  AccessDeniedError,
  createHumanMembershipId,
  createHumanUserId,
  createHumanAccessApplication,
  createInMemoryHumanAccessStore,
  type ExternalHumanIdentity,
  type HumanAccessApplication,
  type HumanAccessEligibilitySynchronizer,
  type HumanAccessStore,
  type HumanMembership,
} from "@humber-foundry/application";

import {
  authenticateCloudflareAccessIdentity,
} from "./access-authentication";
import { createD1HumanAccessStore } from "./d1-human-access-store";
import {
  createDeferredAccessEligibilitySynchronizer,
  HumanAccessConfigurationError,
  type HumanAccessEnvironment,
} from "./human-access-configuration";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { referenceSiteApplication } from "./reference-installation";
import {
  AccessIdentityError,
  validateCloudflareAccessAssertion,
} from "./access-identity";
import { readVerifiedDashboardIdentity } from "./verified-dashboard-identity";

type AuthorizedHumanAccessRequestContext = Readonly<{
  state: "authorized";
  identity: ExternalHumanIdentity;
  membership: HumanMembership;
  application: HumanAccessApplication;
}>;
type InvitedHumanAccessRequestContext = Readonly<{
  state: "invited";
  identity: ExternalHumanIdentity;
  application: HumanAccessApplication;
}>;
export type HumanAccessRequestContext =
  | AuthorizedHumanAccessRequestContext
  | InvitedHumanAccessRequestContext;
export type AuthenticatedHumanIdentityContext = Readonly<{
  identity: ExternalHumanIdentity;
  authorize(): Promise<HumanAccessRequestContext>;
}>;

const localIdentity: ExternalHumanIdentity = Object.freeze({
  binding: {
    issuer: "https://local.cloudflareaccess.com",
    subject: "local-owner",
  },
  email: "owner@localhost.test",
  nonce: "local-access-nonce",
});
const localStore = createInMemoryHumanAccessStore({
  memberships: [
    {
      id: createHumanMembershipId("membership-local-owner"),
      siteId: referenceSiteApplication.siteId,
      userId: createHumanUserId("user-local-owner"),
      email: localIdentity.email,
      identityBinding: localIdentity.binding,
      role: "owner",
      status: "active",
    },
  ],
});
const localEligibilitySynchronizer: HumanAccessEligibilitySynchronizer = {
  async replaceExactEmailEligibility() {},
};

export async function authorizeAuthenticatedHumanIdentity({
  authorize,
}: AuthenticatedHumanIdentityContext): Promise<HumanAccessRequestContext> {
  return authorize();
}

async function authorizeIdentity({
  identity,
  store,
  eligibilitySynchronizer,
}: {
  identity: ExternalHumanIdentity;
  store: HumanAccessStore;
  eligibilitySynchronizer: HumanAccessEligibilitySynchronizer;
}): Promise<HumanAccessRequestContext> {
  const application = createHumanAccessApplication({
    siteId: referenceSiteApplication.siteId,
    store,
    eligibilitySynchronizer,
  });

  try {
    const membership = await application.queries.requireCapability({
      actor: identity,
      capability: "dashboard.view",
    });
    return { state: "authorized", identity, membership, application };
  } catch (error) {
    if (
      !(error instanceof AccessDeniedError) ||
      (error.code !== "membership_not_found" &&
        error.code !== "membership_not_active")
    ) {
      throw error;
    }
  }

  if (await application.queries.canActivateInvitation({ actor: identity })) {
    return { state: "invited", identity, application };
  }
  throw new AccessDeniedError("membership_not_found");
}

export async function authenticateHumanAccessRequest({
  requestHeaders,
  runtime,
  environment,
  store,
  validateAssertion = validateCloudflareAccessAssertion,
}: {
  requestHeaders: Headers;
  runtime: "development" | "production" | "test";
  environment: HumanAccessEnvironment;
  store?: HumanAccessStore;
  validateAssertion?: typeof validateCloudflareAccessAssertion;
}): Promise<HumanAccessRequestContext> {
  return authorizeAuthenticatedHumanIdentity(
    await authenticateHumanIdentityRequest({
      requestHeaders,
      runtime,
      environment,
      store,
      validateAssertion,
    }),
  );
}

export async function authenticateHumanIdentityRequest({
  requestHeaders,
  runtime,
  environment,
  store,
  validateAssertion = validateCloudflareAccessAssertion,
}: {
  requestHeaders: Headers;
  runtime: "development" | "production" | "test";
  environment: HumanAccessEnvironment;
  store?: HumanAccessStore;
  validateAssertion?: typeof validateCloudflareAccessAssertion;
}): Promise<AuthenticatedHumanIdentityContext> {
  if (runtime === "development") {
    return {
      identity: localIdentity,
      authorize: () =>
        authorizeIdentity({
          identity: localIdentity,
          store: store ?? localStore,
          eligibilitySynchronizer: localEligibilitySynchronizer,
        }),
    };
  }

  if (environment.FOUNDRY_DB === undefined && store === undefined) {
    throw new HumanAccessConfigurationError();
  }

  const identity = await authenticateCloudflareAccessIdentity({
    requestHeaders,
    environment,
    validateAssertion,
  });

  return {
    identity,
    authorize: () =>
      authorizeIdentity({
        identity,
        store: store ?? createD1HumanAccessStore(environment.FOUNDRY_DB!),
        eligibilitySynchronizer:
          store === undefined
            ? createDeferredAccessEligibilitySynchronizer(environment)
            : localEligibilitySynchronizer,
      }),
  };
}

export async function loadHumanIdentityRequestContext(
  requestHeaders: Headers,
): Promise<AuthenticatedHumanIdentityContext> {
  if (process.env.NODE_ENV === "development") {
    return authenticateHumanIdentityRequest({
      requestHeaders,
      runtime: "development",
      environment: {},
    });
  }

  const env = await loadHumanAccessEnvironment();
  return authenticateHumanIdentityRequest({
    requestHeaders,
    runtime: process.env.NODE_ENV,
    environment: env as HumanAccessEnvironment,
  });
}

export async function loadHumanAccessRequestContext(
  requestHeaders: Headers,
): Promise<HumanAccessRequestContext> {
  if (process.env.NODE_ENV === "development") {
    return authorizeAuthenticatedHumanIdentity(
      await loadHumanIdentityRequestContext(requestHeaders),
    );
  }

  const verifiedIdentity =
    readVerifiedDashboardIdentity(requestHeaders);
  if (verifiedIdentity === null) {
    throw new AccessIdentityError();
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new HumanAccessConfigurationError();
  }
  return authorizeIdentity({
    identity: verifiedIdentity,
    store: createD1HumanAccessStore(environment.FOUNDRY_DB),
    eligibilitySynchronizer:
      createDeferredAccessEligibilitySynchronizer(environment),
  });
}
