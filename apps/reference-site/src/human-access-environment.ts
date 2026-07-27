import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { HumanAccessEnvironment } from "./human-access-configuration";

export {
  HumanAccessConfigurationError,
} from "./human-access-configuration";
export type { HumanAccessEnvironment } from "./human-access-configuration";

export async function loadHumanAccessEnvironment(): Promise<HumanAccessEnvironment> {
  if (process.env.NODE_ENV === "development") {
    return {
      FOUNDRY_CANONICAL_ORIGIN: "http://localhost:3000",
      FOUNDRY_CSRF_SECRET: "local-development-csrf-secret",
      FOUNDRY_SUBSCRIBER_IDENTITY_SECRET:
        "local-development-subscriber-identity-secret",
      FOUNDRY_ACCESS_AUDIENCE: "local-development-audience",
    };
  }
  const { env } = await getCloudflareContext({ async: true });
  return env as HumanAccessEnvironment;
}
