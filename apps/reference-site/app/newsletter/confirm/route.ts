import {
  NewsletterConfirmationExpiredError,
  NewsletterConfirmationLinkInvalidError,
} from "@humber-foundry/application";

import { loadNewsletterSignupApplication } from "../../../src/newsletter-signup-runtime";
import {
  escapeHtmlAttribute,
  newsletterPublicPage,
} from "../../../src/newsletter-public-page";

const html = (body: string, status = 200) =>
  newsletterPublicPage({
    title: "Confirm your newsletter signup",
    body,
    status,
  });

/**
 * The page a person reaches from the confirmation message.
 *
 * `GET` shows a button and `POST` does the work, so a mail scanner that opens
 * every link in a message cannot subscribe somebody. The page is plain HTML and
 * works with JavaScript turned off.
 *
 * No address appears in this page, in its URL, or in any error it returns.
 */

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
      `<input type="hidden" name="token" value="${escapeHtmlAttribute(token)}">` +
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
    // Only a link this site refuses is reported as a bad link. Anything else
    // is a fault in this code, and a visitor must not be told their link was
    // wrong when it was not.
    if (
      error instanceof NewsletterConfirmationLinkInvalidError ||
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
