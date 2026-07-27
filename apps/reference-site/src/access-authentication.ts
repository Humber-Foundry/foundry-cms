import {
  AccessIdentityError,
  createRemoteCloudflareAccessKeySet,
  validateCloudflareAccessAssertion,
} from "./access-identity";
import {
  readAccessAssertionConfiguration,
  type HumanAccessEnvironment,
} from "./human-access-configuration";

const keySetsByIssuer = new Map<
  string,
  ReturnType<typeof createRemoteCloudflareAccessKeySet>
>();

export const cloudflareAccessAssertionHeader =
  "cf-access-jwt-assertion";

export async function authenticateCloudflareAccessIdentity({
  requestHeaders,
  environment,
  validateAssertion = validateCloudflareAccessAssertion,
}: {
  requestHeaders: Headers;
  environment: HumanAccessEnvironment;
  validateAssertion?: typeof validateCloudflareAccessAssertion;
}) {
  const configuration = readAccessAssertionConfiguration(environment);
  const assertion = requestHeaders.get(cloudflareAccessAssertionHeader);
  if (assertion === null || assertion === "") {
    throw new AccessIdentityError();
  }

  let keySet = keySetsByIssuer.get(configuration.issuer);
  if (keySet === undefined) {
    keySet = createRemoteCloudflareAccessKeySet(configuration);
    keySetsByIssuer.set(configuration.issuer, keySet);
  }
  return validateAssertion({
    assertion,
    configuration,
    keySet,
  });
}
