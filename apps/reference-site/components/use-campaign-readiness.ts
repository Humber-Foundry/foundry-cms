"use client";

import { useEffect, useState } from "react";

import {
  readCampaignReadiness,
  type DeliveryReadiness,
} from "./campaign-operations";

/**
 * Whether this installation can write and send email, read once when a
 * Newsletter screen opens.
 *
 * All three screens need the same two answers, and they must say the same
 * thing about them, so they read them the same way.
 *
 * `senderDetailsMissing` is the one that stops writing: every email carries a
 * compliance footer built from the installation's own name and postal address,
 * and Foundry never invents one, so while they are absent the server refuses
 * to store a revision. Readiness is a hint about the installation, not a step;
 * when it cannot be read the screens still show the server's own refusals.
 */
export function useCampaignReadiness(): Readonly<{
  delivery: DeliveryReadiness | null;
  senderDetails: DeliveryReadiness | null;
  senderDetailsMissing: boolean;
}> {
  const [delivery, setDelivery] = useState<DeliveryReadiness | null>(null);
  const [senderDetails, setSenderDetails] = useState<DeliveryReadiness | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    void readCampaignReadiness().then((readiness) => {
      if (current && readiness !== null) {
        setDelivery(readiness.delivery);
        setSenderDetails(readiness.senderDetails);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  return {
    delivery,
    senderDetails,
    senderDetailsMissing: senderDetails?.state === "not_configured",
  };
}
