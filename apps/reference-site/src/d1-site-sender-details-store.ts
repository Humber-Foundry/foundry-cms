import type { D1DatabaseBinding } from "./d1-human-access-store";
import type { SiteSenderDetails } from "./site-sender-details";

/**
 * Where the sender details an Owner edits are kept, one row per site.
 *
 * Reading returns `null` when nothing was ever saved, which is what tells the
 * reader to fall back to this installation's environment variables. Saving
 * replaces all five values at once, so saving the same values twice leaves the
 * same row: the write is a full replacement and needs no separate idempotency
 * record. See ADR-0048.
 */
export type SiteSenderDetailsStore = Readonly<{
  read(siteId: string): Promise<SiteSenderDetails | null>;
  save(input: {
    siteId: string;
    details: SiteSenderDetails;
    savedBy: string;
    savedAt: string;
  }): Promise<void>;
}>;

type SenderDetailsRow = {
  legal_name: string;
  postal_address: string;
  contact_url: string;
  unsubscribe_url: string;
  sender_identity_id: string;
};

export function createD1SiteSenderDetailsStore(
  database: D1DatabaseBinding,
): SiteSenderDetailsStore {
  return Object.freeze({
    async read(siteId: string): Promise<SiteSenderDetails | null> {
      const row = await database
        .prepare(
          `SELECT legal_name, postal_address, contact_url, unsubscribe_url,
                  sender_identity_id
           FROM site_sender_details
           WHERE site_id = ?1`,
        )
        .bind(siteId)
        .first<SenderDetailsRow>();
      if (row === null) return null;
      return Object.freeze({
        legalName: row.legal_name,
        postalAddress: row.postal_address,
        contactUrl: row.contact_url,
        unsubscribeUrl: row.unsubscribe_url,
        senderIdentityId: row.sender_identity_id,
      });
    },
    async save({ siteId, details, savedBy, savedAt }) {
      await database
        .prepare(
          `INSERT INTO site_sender_details (
             site_id, legal_name, postal_address, contact_url,
             unsubscribe_url, sender_identity_id, updated_at, updated_by
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (site_id) DO UPDATE SET
             legal_name = excluded.legal_name,
             postal_address = excluded.postal_address,
             contact_url = excluded.contact_url,
             unsubscribe_url = excluded.unsubscribe_url,
             sender_identity_id = excluded.sender_identity_id,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        )
        .bind(
          siteId,
          details.legalName,
          details.postalAddress,
          details.contactUrl,
          details.unsubscribeUrl,
          details.senderIdentityId,
          savedAt,
          savedBy,
        )
        .run();
    },
  });
}

/**
 * A store for an installation that has no database, used by local development.
 * It keeps nothing, so every read falls back to the environment variables and
 * every save is dropped.
 */
export const emptySiteSenderDetailsStore: SiteSenderDetailsStore =
  Object.freeze({
    async read() {
      return null;
    },
    async save() {
      return;
    },
  });
