export type MediaUploadAttempt = Readonly<{
  assetId: string;
  idempotencyKey: string;
  body: FormData;
}>;

export function mediaUploadAttemptAfterResult(
  attempt: MediaUploadAttempt,
  confirmed: boolean,
) {
  return confirmed ? null : attempt;
}
