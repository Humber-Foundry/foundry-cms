# ADR-0046: The email preview draws the bytes that will be sent, and a review is read before a send

- **Status:** Accepted
- **Date:** 2026-09-22
- **Follows:** [ADR-0006](ADR-0006-bulk-campaign-execution-boundary.md),
  [ADR-0014](ADR-0014-campaign-images.md),
  [ADR-0030](ADR-0030-campaign-channel-configuration-is-a-value.md),
  [ADR-0039](ADR-0039-mcp-campaign-lifecycle-tools.md)

## Context

The owner asked for the same three things in two reviews: see the email as it
will arrive, send himself a test, then read what is about to happen and only
then send it. Issue
[#225](https://github.com/Humber-Foundry/foundry-cms/issues/225) records the
review; issue [#238](https://github.com/Humber-Foundry/foundry-cms/issues/238)
is this change.

Three faults sat in the way.

**The preview was a second drawing.** The dashboard drew the campaign's rich
text again with the dashboard's own components and styles. The bytes the
delivery provider actually sends come from `campaign-renderer.ts`. Two
drawings of one email can disagree, and only one of them is posted.

**A refused test read as a fault.** In local development the runtime holds no
provider credentials and every adapter refuses, so the test step failed with
the provider's own code and the two send steps stayed shut. Nothing on screen
said why.

**Nothing said what a send would do.** The send step offered "Send it now"
with no recipient count, no subject and no sender details anywhere near it.

## Decision

**1. The preview frame draws the renderer's own bytes.**

The dashboard puts `rendered.html.bytes` — the exact artifact the Content ID
fingerprints — into a sandboxed frame. It makes two changes to those bytes and
no others, both in `campaignPreviewDocument`:

- One content security policy and one base target are put at the top of the
  head. The policy is `default-src 'none'; img-src 'self'; style-src
  'unsafe-inline'`, so the frame runs no script and reaches no address off this
  site. The base target sends every link to a new browsing context, which the
  sandbox refuses, so a press on a link in the preview navigates nothing.
- Every gallery picture is drawn by its same-origin `/api/media/<assetId>`
  path, the rule the rest of the dashboard already applies. A campaign stores
  each picture as an absolute address so a mail client can load it (ADR-0014),
  and that address names the public origin, which the dashboard may not be
  running on. A picture from anywhere else is left exactly as written and the
  policy then refuses it. The screen counts those and says so under the frame,
  so a gap in the preview is never left unexplained.

The frame carries `sandbox="allow-same-origin"` and nothing else. Without
`allow-scripts` nothing in the email can run; `allow-same-origin` is what lets
`img-src 'self'` name this site, so the email's own photos draw. A test takes
both changes back and asserts the result is the renderer's bytes character for
character.

The frame is set to the exact width the person chooses — 600 pixels for a
computer, 390 for a phone — and never scaled, so the lines break where they
will break in a real inbox.

**2. A refusal says which settings are absent.**

Delivery readiness in local development now names every delivery setting in
`missingSettings`, because local development holds none of them. That is a
fact about the installation, not a fault, and the test step says so in plain
words with the names after it. The alternative — a bare `provider_unavailable`
— reads as a bug in the dashboard when the answer is that the site is not
connected.

**3. The review before a send is read from the sent revision, and the person
confirms it.**

The campaigns API answers one campaign's report with a `sendSummary` built
from the one revision the rendered bytes came from: the recipient count, the
subject, the sending name and address, the reply address, the footer holding
the postal address, and the unsubscribe address. The screen shows the review
only while the report and the screen hold that same revision; otherwise it
offers no send control and asks for a reload.

The review carries one tick, "I have read this and it is right." Approving,
sending now and picking a send time all stay shut until it is ticked. One tick
opens one step: it clears when the email's fingerprint changes, because a
changed email has not been read, and it clears when the approval changes, so
the tick that opened "Approve this email for sending" is not still ticked when
the same screen turns into "Send to 412 people now". The confirm control names
the count.

The sending name and address leave the server. They are the installation's own
sending identity, which every recipient already reads in their inbox. A test
recipient's address is a different thing and still never leaves the server;
only membership ids do.

Nothing here weakens the existing rules. The server still requires a delivered
test, the owner's confirmation of it and a matching fingerprint, and every
refusal code and its wording are unchanged. An agent still never sends
(ADR-0039).

## Consequences

- The preview and the sent email cannot disagree about the words, because they
  are the same bytes. A renderer change shows in the dashboard with no second
  edit.
- They can disagree about pictures. A picture kept on another website is
  refused by the policy and does not draw, and the line under the frame says
  how many. A gallery photo always draws.
- The preview shows raw email HTML, so it carries none of the dashboard's
  typography. That is the point: an inbox carries none of it either.
- Adding a setting to `campaignDeliverySettingNames` changes what the local
  development step names. That is wanted: the list is the answer to "what does
  a connected site hold".
- One more revision read per campaign report. It is the same revision the
  render already loaded.

## Alternatives considered

**Keep the dashboard's own drawing and add widths to it.** Rejected: it does
not answer the owner's question, which is what the email looks like when it
arrives.

**Block the network by stripping every address out of the preview.** Rejected:
an email with no pictures is not the email as it will arrive. The policy
refuses everything off this site instead, and the site's own photos still draw.

**Allow pictures from any `https://` address so every email draws whole.**
Rejected: the dashboard would then fetch from whatever address a campaign
carries, which a preview must not do. The count under the frame is the cheaper
answer, and an owner who has to see the picture can send themselves a test.

**Add a separate reply-to setting.** Rejected as out of scope. The delivery
adapter sends no reply-to header, so a reply goes to the sending address, and
the review says exactly that. Making sender details editable is
[#240](https://github.com/Humber-Foundry/foundry-cms/issues/240).
