import { NewsletterConfirmationExpiredError } from "@humber-foundry/application";

import { loadNewsletterSignupApplication } from "../../../src/newsletter-signup-runtime";

/**
 * The page a person reaches from the confirmation message.
 *
 * `GET` shows a button and `POST` does the work, so a mail scanner that opens
 * every link in a message cannot subscribe somebody. The page is plain HTML and
 * works with JavaScript turned off.
 *
 * No address appears in this page, in its URL, or in any error it returns.
 */

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width">` +
      `<title>Confirm your newsletter signup</title></head>` +
      `<body>${body}</body></html>`,
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

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const expiredPage =
  "<main><h1>This confirmation link is no longer valid</h1>" +
  "<p>Links stop working after a day. Sign up again to get a new one.</p></main>";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (token === "") {
    return html("<main><h1>Confirmation link required</h1></main>", 400);
  }
  return html(
    `<main><h1>Confirm your newsletter signup</h1>` +
      `<p>Press the button to join the list. Nothing is added until you do.</p>` +
      `<form method="post">` +
      `<input type="hidden" name="token" value="${escapeAttribute(token)}">` +
      `<button type="submit">Confirm signup</button></form></main>`,
  );
}

export async function POST(request: Request) {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
  } catch {
    return html(expiredPage, 400);
  }
  if (token === "") return html(expiredPage, 400);

  try {
    const application = await loadNewsletterSignupApplication();
    await application.confirmSignup({ token });
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof NewsletterConfirmationExpiredError
    ) {
      return html(expiredPage, 400);
    }
    return html(
      "<main><h1>We could not confirm your signup just now</h1>" +
        "<p>Please try the link again in a few minutes.</p></main>",
      503,
    );
  }
  return html(
    "<main><h1>You are on the list</h1>" +
      "<p>Every message we send has an unsubscribe link at the foot of it.</p></main>",
  );
}
