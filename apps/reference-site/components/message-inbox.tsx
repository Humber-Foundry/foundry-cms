import {
  isPublicFormReplyAddress,
  type PublicFormInboxMessage,
  type PublicFormReceiptId,
} from "@humber-foundry/application";

import { formatDashboardMoment } from "@/src/dashboard-time";

/**
 * The inbox list. One row is one message a visitor sent: who wrote it, when it
 * arrived, which form it came from, and the first line of what they said.
 * Opening a row shows the whole message and marks it read.
 */
export function MessageInbox({
  messages,
  olderCursor,
}: {
  messages: ReadonlyArray<PublicFormInboxMessage>;
  olderCursor: PublicFormReceiptId | null;
}) {
  if (messages.length === 0) {
    return (
      <p className="empty-state">
        No messages yet. Anything sent through a form on your site arrives
        here.
      </p>
    );
  }

  return (
    <>
      <ul className="message-list">
        {messages.map((message) => (
          <li
            className={message.read ? "message-item" : "message-item message-unread"}
            key={message.receiptId}
          >
            <a
              className="message-open"
              href={`/dash/forms/${encodeURIComponent(message.receiptId)}`}
            >
              <span className="message-sender">
                {message.senderName ?? "Someone"}
                {message.read ? null : (
                  <span className="message-flag">Unread</span>
                )}
              </span>
              <span className="message-preview">
                {message.payloadDeleted
                  ? "This message was erased. Only its receipt remains."
                  : message.preview === ""
                    ? "No preview available."
                    : message.preview}
              </span>
              <span className="message-meta">
                {message.formId} form · {formatDashboardMoment(message.acceptedAt)}
              </span>
            </a>
            {message.replyAddress !== null &&
            isPublicFormReplyAddress(message.replyAddress) ? (
              <a
                className="message-reply"
                href={`mailto:${message.replyAddress}`}
              >
                Reply
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {olderCursor === null ? null : (
        <p className="message-older">
          <a href={`/dash/forms?older=${encodeURIComponent(olderCursor)}`}>
            Show older messages
          </a>
        </p>
      )}
    </>
  );
}
