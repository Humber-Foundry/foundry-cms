# ADR-0010: Messages is an inbox, and the owner notification is demoted

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The Messages destination showed three things: the notification emails to the
owner that failed to send, the submissions the spam check held back, and queue
statistics about those notification emails. It never showed the messages
people sent. The page therefore read as if the owner were sending something,
and the list of what arrived was missing.

Three facts about the existing design shaped this decision.

`public_form_submissions` already stores every accepted submission with its
fields, its receipt and the instant it arrived. No query listed them. Every
read of a submission's content went through `viewSubmission`, one receipt at a
time, and wrote a `submission_viewed` row into
`public_form_operation_audit_events`.

Nothing recorded whether a human had opened a submission. The
`submission_viewed` audit rows are append-only facts about one membership's
act of reading. They are not a per-submission state, and querying them to
build one would make an audit trail into application state.

The notification email is a separate machine from the submission. A submission
is committed first; the notification job is retried, can fail permanently, and
can be replayed. That separation is the reason a failed notification never
loses a message, and it is worth keeping.

## Decision

### Messages leads with received submissions

`/dash/forms` opens on an inbox: accepted submissions, newest first, each row
naming the sender, the time, the form and a preview. Opening a row shows the
whole submission and offers a reply link when the visitor gave an address.

The inbox is a keyset page of 25 ordered by `(accepted_at, submission_id)`
descending, with the cursor carried as the receipt of the last row shown. A
receipt is already public in the dashboard URL, so paging exposes no new
identifier.

### A form declares what its fields mean in a list

`PublicFormFieldDefinition` gains an optional `inboxRole` of `sender`,
`replyAddress` or `preview`. An installation owns its form definitions, so an
installation decides which field names the person, which one holds the address
to reply to, and which one is worth previewing. When a form declares no
preview field, the first declared field that is not the sender or the reply
address is used, which keeps the choice deterministic instead of guessing from
the stored payload.

Field content that reaches a list is therefore bounded by the installation's
own declaration: one name of at most 120 characters, one address, and one
preview line of at most 160 characters, each collapsed to a single line.

### A preview in the inbox is not an audited read

Showing a bounded preview to a holder of `forms.review` is deliberate: the
inbox is useless without it, and the same person may open the message in one
click anyway. Reading the whole submission stays audited and still writes
`submission_viewed`. Listing an inbox page does not write an audit row per
message, because a page view is not a decision to read one message and one row
per listed message per page load would bury the real reads.

The list of submissions held as spam keeps no field content at all. Judging a
held submission means opening it, which is an audited read, so the held list
carries only the form, the receipt and the arrival time.

### A reply link is built only from an address that cannot carry more

`isPublicFormReplyAddress` allows only the characters an ordinary address
needs. A `mailto:` link is read by the visitor's mail client, so a value
containing a comma, an angle bracket or `?subject=` could add a recipient or
compose a whole message. A rejected value is still stored and still shown in
full when a human opens the message; it simply never becomes a link. Both the
application layer and the components that build the link apply the rule, so a
component cannot be handed an unchecked address by a future caller.

### Read state is site-wide and belongs to the site

`public_form_submission_reads` holds one row per submission with the instant it
was first opened and the membership that opened it. Opening a submission
inserts that row with `INSERT OR IGNORE`, in the same batch as the
`submission_viewed` audit row, so the first reader is never replaced.

Read state is shared, not per person: when either the Owner or an Editor opens
a message it is read for everyone. One site has a handful of members who share
one inbox, and per-person state would show the same message as unread to a
second person who has no work left to do on it.

### Owner-notification detail moves to Settings

Messages keeps one line: whether the alerts are arriving, and the fact that
every message is saved here even when an alert fails. The queue counts and the
"send the alert again" control move to a Settings section named "Email alerts
about new messages", which is already Owner-only. The delivery machinery,
including retries, the permanent-failure state and replay, is unchanged.

## Consequences

The inbox needs a migration (`0026_public_form_inbox.sql`) before it can be
read, and the index it adds is what keeps the newest-first page from scanning
every submission.

Read state is not part of the audited backup, so a submission restored into a
recovery target arrives unread. The read row is removed with its submission by
`ON DELETE CASCADE` when a recovery target is wiped.

A form that declares no `inboxRole` on any field lists as "Someone" with no
preview and no reply link. That is truthful — the CMS was told nothing about
what those fields mean — but an installation adding a form should set the
roles at the same time.

The reply rule rejects some valid but rare addresses, such as an
internationalized one. That address is still readable in full on the message's
own page.
