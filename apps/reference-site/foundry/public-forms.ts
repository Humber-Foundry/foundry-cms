import type { PublicFormFieldDefinition } from "@humber-foundry/application";

/**
 * Installation-owned public forms.
 *
 * An adopted repository replaces this list with the forms its own site
 * publishes. Each field says how long a value may be and whether it is
 * required. `inboxRole` says what the field means in the Messages inbox: the
 * person's name, the address to reply to, or the text shown as the preview
 * line. A field with no role is only ever shown when a human opens the
 * message.
 *
 * This module is browser-safe. Keep secrets, provider bindings, and server
 * adapters out of it. The origin and Turnstile settings that complete a form
 * definition come from the deployment environment, not from here.
 */
export type InstalledPublicForm = Readonly<{
  id: string;
  schemaVersion: string;
  turnstileAction: string;
  fields: ReadonlyArray<PublicFormFieldDefinition>;
}>;

export const installedPublicForms: ReadonlyArray<InstalledPublicForm> =
  Object.freeze([
    Object.freeze({
      id: "contact",
      schemaVersion: "1.0.0",
      turnstileAction: "contact",
      fields: Object.freeze([
        Object.freeze({
          id: "name",
          required: true,
          maximumLength: 100,
          inboxRole: "sender",
        }),
        Object.freeze({
          id: "email",
          required: false,
          maximumLength: 254,
          inboxRole: "replyAddress",
        }),
        Object.freeze({
          id: "message",
          required: true,
          maximumLength: 2_000,
          inboxRole: "preview",
        }),
      ]) as ReadonlyArray<PublicFormFieldDefinition>,
    }),
  ]);
