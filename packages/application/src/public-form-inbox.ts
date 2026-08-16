import type {
  PublicFormFieldDefinition,
  PublicFormId,
  PublicFormReceiptId,
} from "./public-form";

/**
 * The inbox shows a message list, not a stored payload. A form says which of
 * its fields names the person, which one holds the address to reply to, and
 * which one is worth previewing. Everything else stays inside the submission
 * until a human opens it.
 */
export type PublicFormInboxFieldRoles = Readonly<{
  sender?: string;
  replyAddress?: string;
  preview?: string;
}>;

export type PublicFormInboxPlan = Readonly<
  Record<
    string,
    Readonly<{
      roles: PublicFormInboxFieldRoles;
      fieldOrder: ReadonlyArray<string>;
    }>
  >
>;

export type PublicFormInboxSummary = Readonly<{
  senderName: string | null;
  replyAddress: string | null;
  preview: string;
}>;

export type PublicFormInboxMessage = PublicFormInboxSummary &
  Readonly<{
    formId: PublicFormId;
    receiptId: PublicFormReceiptId;
    acceptedAt: string;
    read: boolean;
    payloadDeleted: boolean;
  }>;

export type PublicFormInboxPage = Readonly<{
  messages: ReadonlyArray<PublicFormInboxMessage>;
  olderCursor: PublicFormReceiptId | null;
  unreadCount: number;
}>;

export const publicFormInboxPageSize = 25;

const senderLimit = 120;
const previewLimit = 160;
const replyAddressLimit = 254;

/**
 * One address, nothing else.
 *
 * A reply link becomes `mailto:<address>`, so anything the visitor types is
 * read by the mail client. A comma or angle bracket could add a recipient,
 * and `?subject=` or `?bcc=` could fill in a whole message. This pattern
 * therefore allows only the characters an ordinary address needs. It rejects
 * some valid but rare addresses, and a rejected value is still kept and shown
 * in full when a human opens the message — it just never becomes a link.
 */
const replyAddressPattern =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * At most `limit` characters, ellipsis included. The ellipsis replaces the
 * last character it keeps, so a bounded value never exceeds the limit an
 * installation was promised.
 */
function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * One field as a single line, or null when the form has no such field, the
 * stored value is not text, or it is blank.
 */
function singleLineField(
  fields: Readonly<Record<string, unknown>>,
  fieldId: string | undefined,
): string | null {
  if (fieldId === undefined) {
    return null;
  }
  const value = fields[fieldId];
  if (typeof value !== "string") {
    return null;
  }
  const line = singleLine(value);
  return line === "" ? null : line;
}

export function createPublicFormInboxPlan(
  forms: ReadonlyArray<
    Readonly<{
      id: PublicFormId;
      fields: ReadonlyArray<PublicFormFieldDefinition>;
    }>
  >,
): PublicFormInboxPlan {
  const plan: Record<
    string,
    { roles: PublicFormInboxFieldRoles; fieldOrder: ReadonlyArray<string> }
  > = {};
  for (const form of forms) {
    const roles: {
      sender?: string;
      replyAddress?: string;
      preview?: string;
    } = {};
    for (const field of form.fields) {
      if (field.inboxRole !== undefined && roles[field.inboxRole] === undefined) {
        roles[field.inboxRole] = field.id;
      }
    }
    plan[form.id] = {
      roles: Object.freeze(roles),
      fieldOrder: Object.freeze(form.fields.map((field) => field.id)),
    };
  }
  return Object.freeze(plan);
}

export function isPublicFormReplyAddress(value: string): boolean {
  return value.length <= replyAddressLimit && replyAddressPattern.test(value);
}

export function summarizePublicFormSubmission({
  plan,
  formId,
  fields,
}: {
  plan: PublicFormInboxPlan;
  formId: PublicFormId;
  fields: Readonly<Record<string, unknown>>;
}): PublicFormInboxSummary {
  const form = plan[formId];
  if (form === undefined) {
    return { senderName: null, replyAddress: null, preview: "" };
  }
  const senderName = singleLineField(fields, form.roles.sender);
  const replyValue = singleLineField(fields, form.roles.replyAddress);
  const previewFieldId =
    form.roles.preview ??
    form.fieldOrder.find(
      (fieldId) =>
        fieldId !== form.roles.sender && fieldId !== form.roles.replyAddress,
    );
  return {
    senderName: senderName === null ? null : bounded(senderName, senderLimit),
    replyAddress:
      replyValue !== null && isPublicFormReplyAddress(replyValue)
        ? replyValue
        : null,
    preview: bounded(
      singleLineField(fields, previewFieldId) ?? "",
      previewLimit,
    ),
  };
}
