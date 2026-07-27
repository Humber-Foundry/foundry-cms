import type { HumanAccessEligibilitySynchronizer } from "@foundry/application";

export class AccessEligibilitySyncError extends Error {
  constructor() {
    super("access_eligibility_sync_failed");
    this.name = "AccessEligibilitySyncError";
  }
}

type AccessPolicy = Readonly<{
  name?: string;
  decision?: string;
  precedence?: number;
  session_duration?: string;
  approval_groups?: unknown;
  approval_required?: unknown;
  isolation_required?: unknown;
  mfa_config?: unknown;
  purpose_justification_prompt?: unknown;
  purpose_justification_required?: unknown;
  include?: ReadonlyArray<unknown>;
  require?: ReadonlyArray<unknown>;
  exclude?: ReadonlyArray<unknown>;
}>;

const preservedPolicyHardeningFields = [
  "approval_groups",
  "approval_required",
  "isolation_required",
  "mfa_config",
  "purpose_justification_prompt",
  "purpose_justification_required",
] as const;

type PreservedPolicySettings = Readonly<
  Record<string, unknown> & {
    name: string;
    precedence: number;
    session_duration: string;
  }
>;

function readExactEmails(policy: AccessPolicy): string[] | null {
  if (!Array.isArray(policy.include)) {
    return null;
  }
  const emails: string[] = [];
  for (const rule of policy.include) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Object.keys(rule).length !== 1 ||
      !("email" in rule) ||
      typeof rule.email !== "object" ||
      rule.email === null ||
      !("email" in rule.email) ||
      typeof rule.email.email !== "string"
    ) {
      return null;
    }
    emails.push(rule.email.email);
  }
  return emails.sort();
}

function requiresLoginMethod(
  policy: AccessPolicy,
  loginMethodId: string,
) {
  return (
    policy.require?.some(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        "login_method" in rule &&
        typeof rule.login_method === "object" &&
        rule.login_method !== null &&
        "id" in rule.login_method &&
        rule.login_method.id === loginMethodId,
    ) ?? false
  );
}

function isExactPolicy(
  policy: AccessPolicy,
  desiredEmails: ReadonlyArray<string>,
  loginMethodId: string,
) {
  const actualEmails = readExactEmails(policy);
  return (
    policy.decision === "allow" &&
    actualEmails !== null &&
    JSON.stringify(actualEmails) === JSON.stringify(desiredEmails) &&
    requiresLoginMethod(policy, loginMethodId) &&
    Array.isArray(policy.exclude) &&
    policy.exclude.length === 0
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function preservesRequirements(
  policy: AccessPolicy,
  requirements: ReadonlyArray<unknown>,
) {
  if (!Array.isArray(policy.require)) {
    return false;
  }
  const actual = new Set(policy.require.map(canonicalJson));
  return requirements.every((requirement) =>
    actual.has(canonicalJson(requirement)),
  );
}

function preservesPolicySettings(
  policy: AccessPolicy,
  settings: PreservedPolicySettings,
) {
  return Object.entries(settings).every(
    ([key, expected]) =>
      key in policy &&
      canonicalJson(policy[key as keyof AccessPolicy]) ===
        canonicalJson(expected),
  );
}

function snapshotPolicySettings(
  policy: AccessPolicy,
): PreservedPolicySettings {
  const settings: Record<string, unknown> = {
    name:
      typeof policy.name === "string" && policy.name.trim() !== ""
        ? policy.name
        : "Foundry CMS exact human access",
    precedence:
      typeof policy.precedence === "number" ? policy.precedence : 1,
    session_duration:
      typeof policy.session_duration === "string" &&
      policy.session_duration.trim() !== ""
        ? policy.session_duration
        : "8h",
  };
  for (const field of preservedPolicyHardeningFields) {
    if (Object.hasOwn(policy, field)) {
      settings[field] = policy[field];
    }
  }
  return settings as PreservedPolicySettings;
}

async function readPolicy(response: Response): Promise<AccessPolicy> {
  if (!response.ok) {
    throw new AccessEligibilitySyncError();
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    body.success !== true ||
    !("result" in body) ||
    typeof body.result !== "object" ||
    body.result === null
  ) {
    throw new AccessEligibilitySyncError();
  }
  return body.result;
}

export function createCloudflareAccessEligibilitySynchronizer({
  accountId,
  applicationId,
  policyId,
  loginMethodId,
  apiToken,
  fetcher = fetch,
}: {
  accountId: string;
  applicationId: string;
  policyId: string;
  loginMethodId: string;
  apiToken: string;
  fetcher?: typeof fetch;
}): HumanAccessEligibilitySynchronizer {
  if (
    [accountId, applicationId, policyId, loginMethodId, apiToken].some(
      (value) => value.trim() === "",
    )
  ) {
    throw new AccessEligibilitySyncError();
  }
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/access/apps/${encodeURIComponent(applicationId)}` +
    `/policies/${encodeURIComponent(policyId)}`;
  const headers = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  };

  return {
    async replaceExactEmailEligibility(emails) {
      try {
        const desiredEmails = [...new Set(emails)].sort();
        const current = await readPolicy(
          await fetcher(endpoint, { method: "GET", headers }),
        );
        if (isExactPolicy(current, desiredEmails, loginMethodId)) {
          return;
        }
        const currentRequirements = Array.isArray(current.require)
          ? current.require
          : [];
        const requirements = requiresLoginMethod(current, loginMethodId)
          ? currentRequirements
          : [
              ...currentRequirements,
              { login_method: { id: loginMethodId } },
            ];
        const policySettings = snapshotPolicySettings(current);
        const update = await fetcher(endpoint, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            ...policySettings,
            decision: "allow",
            include: desiredEmails.map((email) => ({ email: { email } })),
            require: requirements,
            exclude: [],
          }),
        });
        await readPolicy(update);

        const verified = await readPolicy(
          await fetcher(endpoint, { method: "GET", headers }),
        );
        if (
          !isExactPolicy(verified, desiredEmails, loginMethodId) ||
          !preservesRequirements(verified, requirements) ||
          !preservesPolicySettings(verified, policySettings)
        ) {
          throw new AccessEligibilitySyncError();
        }
      } catch (error) {
        if (error instanceof AccessEligibilitySyncError) {
          throw error;
        }
        throw new AccessEligibilitySyncError();
      }
    },
  };
}
