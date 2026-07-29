import {
  SubscriberNotFoundError,
} from "@foundry/application";

import {
  loadHumanAccessEnvironment,
} from "../../../src/human-access-environment";
import {
  readSubscriberIdentityKeySecret,
} from "../../../src/human-access-configuration";
import {
  verifyNewsletterUnsubscribeToken,
} from "../../../src/newsletter-unsubscribe-token";
import {
  loadSubscriberLedgerIntegrationApplication,
} from "../../../src/subscriber-ledger-runtime";

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width">` +
      `<title>Newsletter preferences</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function tokenFromUrl(request: Request) {
  return new URL(request.url).searchParams.get("token") ?? "";
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function GET(request: Request) {
  const token = tokenFromUrl(request);
  if (token === "") {
    return html("<h1>Unsubscribe link required</h1>", 400);
  }
  try {
    const environment = await loadHumanAccessEnvironment();
    await verifyNewsletterUnsubscribeToken({
      token,
      secret: readSubscriberIdentityKeySecret(environment),
    });
  } catch {
    return html(
      "<main><h1>This unsubscribe link is invalid or expired</h1></main>",
      400,
    );
  }
  return html(
    `<main><h1>Unsubscribe from this newsletter?</h1>` +
      `<form method="post">` +
      `<input type="hidden" name="token" value="${escapeAttribute(token)}">` +
      `<button type="submit">Unsubscribe</button></form></main>`,
  );
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const environment = await loadHumanAccessEnvironment();
    const verified = await verifyNewsletterUnsubscribeToken({
      token,
      secret: readSubscriberIdentityKeySecret(environment),
    });
    const application = await loadSubscriberLedgerIntegrationApplication();
    await application.provider.ingestSuppressionByIdentityKey({
      provider: "foundry_unsubscribe",
      providerEventId: verified.providerEventId,
      identityKey: verified.identityKey,
      reason: "unsubscribed",
      occurredAt: new Date().toISOString(),
    });
    return html(
      "<main><h1>You are unsubscribed</h1><p>No further action is required.</p></main>",
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof SubscriberNotFoundError) {
      return html(
        "<main><h1>This unsubscribe link is invalid or expired</h1></main>",
        400,
      );
    }
    throw error;
  }
}
