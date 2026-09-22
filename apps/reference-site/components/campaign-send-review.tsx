"use client";

import {
  unsubscribeAddressShown,
  type CampaignSendSummary,
} from "./campaign-operations";

/** One labelled line of the review. */
function ReviewFact({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="send-review-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * How many people this email goes to, in a sentence.
 *
 * A count of one reads wrong as "1 people", and a count of zero has to say
 * that nobody would get it rather than leave a bare number on screen.
 */
export function recipientCountSentence(count: number): string {
  if (count === 0) return "Nobody is on your list yet, so nobody would get it.";
  return count === 1 ? "Going to 1 person." : `Going to ${count} people.`;
}

/** What the confirm control says it will do. */
export function sendNowLabel(count: number): string {
  return count === 1 ? "Send to 1 person now" : `Send to ${count} people now`;
}

/**
 * What the owner reads before an email goes to the whole list.
 *
 * Every line is read from the one campaign revision that would be sent, so the
 * review can never describe a different email from the one that goes out. The
 * tick is the confirmation: the send and schedule controls beside it stay shut
 * until it is ticked, and it clears again whenever the email changes. See
 * ADR-0046.
 */
export function CampaignSendReview({
  summary,
  reviewed,
  busy,
  onReviewed,
}: {
  summary: CampaignSendSummary;
  reviewed: boolean;
  busy: boolean;
  onReviewed(reviewed: boolean): void;
}) {
  const senderMissing =
    summary.senderName === null || summary.senderAddress === null;
  const noSendingAddress = "This site has no sending address yet.";

  return (
    <div className="send-review">
      <p className="send-review-count">
        {recipientCountSentence(summary.recipientCount)}
      </p>
      <dl className="send-review-facts">
        <ReviewFact name="Subject">{summary.subject}</ReviewFact>
        <ReviewFact name="Sent by">
          {senderMissing
            ? "This site has no sending name yet, so nothing can be sent."
            : summary.senderName}
        </ReviewFact>
        <ReviewFact name="From this address">
          {senderMissing
            ? noSendingAddress
            : summary.senderAddress}
        </ReviewFact>
        <ReviewFact name="Replies go to">
          {summary.replyAddress === null
            ? noSendingAddress
            : summary.replyAddress}
        </ReviewFact>
        <ReviewFact name="The footer, with your postal address">
          {summary.footer}
        </ReviewFact>
        <ReviewFact name="Where people stop the emails">
          {unsubscribeAddressShown(summary.unsubscribeAddress)}
        </ReviewFact>
      </dl>
      <label className="send-step-check">
        <input
          type="checkbox"
          name="sendReviewed"
          checked={reviewed}
          disabled={busy}
          onChange={(event) => onReviewed(event.target.checked)}
        />
        <span>I have read this and it is right.</span>
      </label>
    </div>
  );
}
