import type { CampaignDeliveryEventType } from "@humber-foundry/application";

/**
 * Brevo names the same delivery fact differently in its transactional webhook
 * and in its tag-filtered event report, and several provider names collapse to
 * one Foundry event type. Both surfaces read this one table so a provider
 * rename cannot be honoured on one path and missed on the other.
 */
const brevoEventTypes: ReadonlyMap<string, CampaignDeliveryEventType> =
  new Map([
    ["request", "accepted"],
    ["sent", "accepted"],
    ["delivered", "delivered"],
    ["opened", "opened"],
    ["unique_opened", "opened"],
    ["loadedByProxy", "opened"],
    ["click", "clicked"],
    ["clicks", "clicked"],
    ["unsubscribed", "unsubscribed"],
    ["hardBounce", "hard_bounced"],
    ["hardBounces", "hard_bounced"],
    ["spam", "complained"],
    ["softBounce", "soft_bounced"],
    ["softBounces", "soft_bounced"],
    ["blocked", "blocked"],
    ["invalid", "invalid"],
    ["deferred", "deferred"],
    ["error", "provider_error"],
  ]);

export function normalizedBrevoEventType(
  value: unknown,
): CampaignDeliveryEventType | null {
  return typeof value === "string"
    ? brevoEventTypes.get(value) ?? null
    : null;
}

/** The provider's own instant for a fact, or null when it is unusable. */
export function brevoProviderOccurredAt(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The correlation key a bulk send operation carries at Brevo. It is derived
 * from the operation alone so the sending adapter, the webhook and report
 * polling all agree without consulting stored state.
 */
export function brevoBulkCorrelationId(operationId: string) {
  return `brevo-bulk-${operationId}`;
}
