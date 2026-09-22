import { AccessDeniedError } from "@humber-foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import { verifyHumanMutation } from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import { SiteSenderDetailsUnavailableError } from "../../../../src/d1-site-sender-details-store";
import { saveSenderDetails } from "../../../../src/sender-details-runtime";
import { readSenderDetails } from "../../../../src/site-sender-details";

/**
 * Saving the sender details an Owner edits on Settings' Email tab.
 *
 * Only an Owner may save: the capability checked here is `access.manage`, the
 * same owner-only capability the rest of Settings uses. The five values are
 * the Owner's own words and the Owner's own addresses, so this route holds no
 * secret and returns none.
 *
 * A save replaces all five values at once, so sending the same save twice
 * leaves the same stored row. That is why this route does not carry the
 * idempotency record the access-change routes carry: there is no second
 * effect to guard against. See ADR-0048.
 */
export async function POST(request: Request) {
  try {
    const identityContext =
      await loadHumanIdentityRequestContext(request.headers);
    await verifyHumanMutation(request, identityContext.identity);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const details = readSenderDetails(body);
    if (details === null) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }

    const context = await authorizeAuthenticatedHumanIdentity(identityContext);
    const membership = await context.application.queries.requireCapability({
      actor: context.identity,
      capability: "access.manage",
    });

    const problems = await saveSenderDetails({
      details,
      savedBy: membership.id,
      savedAt: new Date().toISOString(),
    });
    if (problems.length > 0) {
      return Response.json(
        { error: "sender_details_invalid", problems },
        { status: 400 },
      );
    }
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: "not_authorized", reason: error.code },
        { status: 403 },
      );
    }
    if (
      error instanceof HumanRequestIntegrityError ||
      error instanceof AccessIdentityError
    ) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityUnavailableError ||
      error instanceof HumanAccessConfigurationError
    ) {
      return Response.json({ error: "access_unavailable" }, { status: 503 });
    }
    // Nothing was written. Saying so keeps the screen honest: it must never
    // report "Saved" for a write this installation had nowhere to put.
    if (error instanceof SiteSenderDetailsUnavailableError) {
      return Response.json(
        { error: "sender_details_unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}
