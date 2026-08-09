import type { NewsletterProviderOwnershipEvidence } from "@humber-foundry/application";

/**
 * Parses the installation's Brevo provisioning evidence from configuration.
 * The human campaign path and the MCP campaign path both need it, and it
 * validates security-sensitive ownership proof, so it lives in one place
 * rather than being copied into each runtime.
 */
export function readProviderOwnershipEvidence(
  value: string | undefined,
  accountScopeFingerprint: string,
): NewsletterProviderOwnershipEvidence {
  if (value === undefined || value.trim() === "") {
    return Object.freeze({
      classification: "evaluation",
      evidenceId: "brevo-evaluation-unverified",
      accountScopeFingerprint,
      verifiedAt: "1970-01-01T00:00:00.000Z",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("brevo_provisioning_evidence_invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).length !== 4 ||
    !("classification" in parsed) ||
    (parsed.classification !== "evaluation" &&
      parsed.classification !== "client_owned") ||
    !("evidenceId" in parsed) ||
    typeof parsed.evidenceId !== "string" ||
    !/^[A-Za-z0-9:._-]{1,200}$/u.test(parsed.evidenceId) ||
    !("accountScopeFingerprint" in parsed) ||
    parsed.accountScopeFingerprint !== accountScopeFingerprint ||
    !("verifiedAt" in parsed) ||
    typeof parsed.verifiedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.verifiedAt))
  ) {
    throw new Error("brevo_provisioning_evidence_invalid");
  }
  return Object.freeze({
    classification: parsed.classification,
    evidenceId: parsed.evidenceId,
    accountScopeFingerprint,
    verifiedAt: parsed.verifiedAt,
  });
}
