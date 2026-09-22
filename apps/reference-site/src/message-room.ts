import type { PublicFormDeliveryHealth } from "@humber-foundry/application";

/**
 * How full the message store is, in words rather than a state name. The
 * percentage is kept because it is the only number that says how much room is
 * left.
 *
 * This moved out of the old single Settings page when Settings became four
 * tabs (#240). It is a plain module so a Server Component can render the
 * sentence without a client boundary.
 */
const roomLeft: Readonly<
  Record<PublicFormDeliveryHealth["capacity"]["state"], string>
> = {
  normal: "There is plenty of room.",
  warning: "It is getting full, so plan what to keep.",
  critical: "There is very little left. Erase messages you no longer need.",
};

export function messageRoomSentence(
  capacity: PublicFormDeliveryHealth["capacity"],
): string {
  return `Messages are using ${capacity.usedPercent.toFixed(
    1,
  )}% of the room they have. ${roomLeft[capacity.state]}`;
}
