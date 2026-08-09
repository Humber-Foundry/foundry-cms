import "server-only";

import {
  AccessDeniedError,
  createInMemorySubscriberLedgerStore,
  createSubscriberLedgerApplication,
  type SubscriberLedgerApplication,
  type SubscriberLedgerStore,
} from "@humber-foundry/application";

import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanAccessRequestContext,
  loadHumanIdentityRequestContext,
  type AuthenticatedHumanIdentityContext,
} from "./human-access-runtime";
import {
  HumanAccessConfigurationError,
  readSubscriberIdentityKeySecret,
} from "./human-access-configuration";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import { referenceSiteApplication } from "./reference-installation";

export type SubscriberLedgerRequestContext = Readonly<{
  identity: Awaited<
    ReturnType<typeof loadHumanAccessRequestContext>
  >["identity"];
  application: SubscriberLedgerApplication;
}>;

const localStore = createInMemorySubscriberLedgerStore();

async function createContext({
  humanContext,
  store,
  identityKeySecret,
}: {
  humanContext: Awaited<
    ReturnType<typeof authorizeAuthenticatedHumanIdentity>
  >;
  store: SubscriberLedgerStore;
  identityKeySecret: string;
}): Promise<SubscriberLedgerRequestContext> {
  if (humanContext.state !== "authorized") {
    throw new AccessDeniedError("capability_not_authorized");
  }
  return {
    identity: humanContext.identity,
    application: createSubscriberLedgerApplication({
      siteId: referenceSiteApplication.siteId,
      store,
      identityKeySecret,
      authorize: (actor, capability) =>
        humanContext.application.queries.requireCapability({
          actor,
          capability,
        }),
    }),
  };
}

async function loadDependencies(): Promise<{
  store: SubscriberLedgerStore;
  identityKeySecret: string;
}> {
  if (process.env.NODE_ENV === "development") {
    return {
      store: localStore,
      identityKeySecret:
        "local-development-subscriber-identity-secret",
    };
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new HumanAccessConfigurationError();
  }
  return {
    store: createD1SubscriberLedgerStore(environment.FOUNDRY_DB),
    identityKeySecret: readSubscriberIdentityKeySecret(environment),
  };
}

export async function loadSubscriberLedgerIntegrationApplication() {
  const dependencies = await loadDependencies();
  return createSubscriberLedgerApplication({
    siteId: referenceSiteApplication.siteId,
    ...dependencies,
    authorize: async () => {
      throw new AccessDeniedError("capability_not_authorized");
    },
  });
}

export async function authorizeSubscriberLedgerIdentity(
  identityContext: AuthenticatedHumanIdentityContext,
) {
  const dependencies = await loadDependencies();
  return createContext({
    humanContext:
      await authorizeAuthenticatedHumanIdentity(identityContext),
    ...dependencies,
  });
}

export async function loadSubscriberLedgerRequestContext(
  requestHeaders: Headers,
) {
  const dependencies = await loadDependencies();
  return createContext({
    humanContext: await loadHumanAccessRequestContext(requestHeaders),
    ...dependencies,
  });
}

export { loadHumanIdentityRequestContext };
