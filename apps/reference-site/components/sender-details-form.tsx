"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  senderDetailFieldNames,
  senderDetailHint,
  senderDetailLabel,
  type SenderDetailFieldName,
  type SenderDetailProblem,
  type SiteSenderDetails,
} from "@/src/site-sender-details";

/**
 * The five sender details, edited in place on Settings' Email tab.
 *
 * Every email must carry a name, a postal address, a way to contact the sender
 * and a way to stop the emails. They used to be settings only whoever
 * installed the site could change, so an owner could read that they were
 * missing and could do nothing about it. This is the form that changes them.
 *
 * A value left empty keeps whatever the installation was already using, so an
 * installation that set these when it was built keeps working after a save
 * that changes only one of them.
 *
 * None of these is a secret. All five are sent to every reader of every email.
 */

const multilineFields: ReadonlySet<SenderDetailFieldName> = new Set([
  "postalAddress",
]);

function inputTypeFor(field: SenderDetailFieldName): string {
  return field === "contactUrl" || field === "unsubscribeUrl" ? "url" : "text";
}

export function SenderDetailsForm({
  values,
  stored,
  localDevelopment,
  csrfToken,
}: {
  /** The values in use now, stored ones first and the installation's own after. */
  values: SiteSenderDetails;
  /** Whether any of these were saved here before. */
  stored: boolean;
  /** Local development sends nothing, so the form says so and saves nothing. */
  localDevelopment: boolean;
  csrfToken: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [problems, setProblems] = useState<
    ReadonlyArray<SenderDetailProblem>
  >([]);

  const problemFor = (field: SenderDetailFieldName) =>
    problems.find((problem) => problem.field === field) ?? null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const details = Object.fromEntries(
      senderDetailFieldNames.map((field) => [
        field,
        String(data.get(field) ?? "").trim(),
      ]),
    );
    setSaving(true);
    setMessage("");
    setProblems([]);
    try {
      const response = await fetch("/api/foundry-cms/sender-details", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify(details),
      });
      if (response.ok) {
        setMessage("Saved. Every new email will use these details.");
        router.refresh();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (
        typeof body === "object" &&
        body !== null &&
        "problems" in body &&
        Array.isArray(body.problems)
      ) {
        setProblems(body.problems as ReadonlyArray<SenderDetailProblem>);
        setMessage("Nothing was saved. Fix the values marked below.");
        return;
      }
      setMessage("The details could not be saved. Try again.");
    } catch {
      setMessage("The details could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="sender-details-form" onSubmit={save}>
      <p className="sender-details-source">
        {localDevelopment
          ? "This is a local copy of the site. Nothing here can be sent, and a save is not kept."
          : stored
            ? "These are the details you saved here."
            : "These are the details whoever set this site up installed. Save them here to change them."}
      </p>
      {senderDetailFieldNames.map((field) => {
        const problem = problemFor(field);
        return (
          <label key={field} className="sender-details-field">
            <span className="sender-details-field-name">
              {senderDetailLabel[field]}
            </span>
            {multilineFields.has(field) ? (
              <textarea
                name={field}
                rows={3}
                defaultValue={values[field]}
                disabled={localDevelopment}
                aria-invalid={problem === null ? undefined : true}
              />
            ) : (
              <input
                name={field}
                type={inputTypeFor(field)}
                defaultValue={values[field]}
                disabled={localDevelopment}
                aria-invalid={problem === null ? undefined : true}
              />
            )}
            <small>{problem === null ? senderDetailHint[field] : problem.message}</small>
          </label>
        );
      })}
      <p className="panel-actions">
        <button
          className="dash-button dash-button-primary"
          type="submit"
          disabled={saving || localDevelopment}
        >
          Save sender details
        </button>
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
