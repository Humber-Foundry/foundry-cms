"use client";

import {
  parseSiteHref,
  type EditableSiteField,
} from "@humber-foundry/site-definition";

/** The four things a link can point at, in the order the picker offers them. */
type LinkTarget = "page" | "section" | "blog" | "email";

type SiteHrefTargets = NonNullable<EditableSiteField["siteHrefTargets"]>;

type ParsedFieldValue = Readonly<{
  target: LinkTarget;
  pageId: string;
  sectionId: string;
  email: string;
}>;

/**
 * Reads a stored href into what the picker shows, through the shared
 * `parseSiteHref`, so the picker and every renderer agree on what a stored
 * value means.
 *
 * A bare `#anchor`, written before this picker existed, always named a
 * section on the home page (ADR-0020), so it opens here the same way:
 * "A section on a page," the home page, that section.
 */
function parseFieldValue(
  value: string,
  targets: SiteHrefTargets,
): ParsedFieldValue {
  const homeId = targets[0]?.id ?? "";
  const parsed = parseSiteHref(value);
  switch (parsed.kind) {
    case "blog":
      return { target: "blog", pageId: homeId, sectionId: "", email: "" };
    case "mailto":
      return {
        target: "email",
        pageId: homeId,
        sectionId: "",
        email: parsed.address,
      };
    case "anchor":
      return {
        target: "section",
        pageId: homeId,
        sectionId: parsed.anchor,
        email: "",
      };
    case "page":
      return parsed.anchor === null
        ? { target: "page", pageId: parsed.pageId, sectionId: "", email: "" }
        : {
            target: "section",
            pageId: parsed.pageId,
            sectionId: parsed.anchor,
            email: "",
          };
    case "unrecognized":
      return { target: "page", pageId: homeId, sectionId: "", email: "" };
  }
}

function buildHref(parsed: ParsedFieldValue): string {
  switch (parsed.target) {
    case "page":
      return `page:${parsed.pageId}`;
    case "section":
      return parsed.sectionId === ""
        ? `page:${parsed.pageId}`
        : `page:${parsed.pageId}#${parsed.sectionId}`;
    case "blog":
      return "blog";
    case "email":
      return `mailto:${parsed.email.trim()}`;
  }
}

const linkTargetLabels: Readonly<Record<LinkTarget, string>> = {
  page: "A page",
  section: "A section on a page",
  blog: "The Blog",
  email: "An email address",
};

/**
 * The page picker: choose a page, a section on a page, the Blog, or an email
 * address, instead of typing a path or an address by hand.
 *
 * The owner's choice is turned into one stored href — `page:<id>`,
 * `page:<id>#<anchor>`, `blog`, or `mailto:<address>` — through `buildHref`,
 * and read back the same way through `parseFieldValue`. `resolveSiteHref` in
 * `@humber-foundry/site-definition` turns that stored value into the address
 * the public site and a preview follow.
 */
export function SiteHrefField({
  id,
  value,
  targets,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  targets: SiteHrefTargets;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onChange(value: string): void;
}) {
  const parsed = parseFieldValue(value, targets);
  const page = targets.find((candidate) => candidate.id === parsed.pageId);
  const firstPageId = targets[0]?.id ?? "";

  const setTarget = (target: LinkTarget) => {
    if (target === "page" || target === "section") {
      const nextPage = page ?? targets[0];
      const nextSection =
        target === "section" ? nextPage?.sections[0]?.id ?? "" : "";
      onChange(
        buildHref({
          target,
          pageId: nextPage?.id ?? firstPageId,
          sectionId: nextSection,
          email: "",
        }),
      );
      return;
    }
    onChange(
      buildHref({ target, pageId: firstPageId, sectionId: "", email: "" }),
    );
  };

  const setPageId = (pageId: string) => {
    const nextPage = targets.find((candidate) => candidate.id === pageId);
    onChange(
      buildHref({
        target: parsed.target,
        pageId,
        sectionId:
          parsed.target === "section" ? nextPage?.sections[0]?.id ?? "" : "",
        email: "",
      }),
    );
  };

  const setSectionId = (sectionId: string) => {
    onChange(buildHref({ ...parsed, sectionId }));
  };

  const setEmail = (email: string) => {
    onChange(buildHref({ ...parsed, email }));
  };

  return (
    <div className="site-href-field" id={id}>
      <select
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        value={parsed.target}
        onChange={(event) => setTarget(event.target.value as LinkTarget)}
      >
        {(Object.keys(linkTargetLabels) as LinkTarget[]).map((target) => (
          <option key={target} value={target}>
            {linkTargetLabels[target]}
          </option>
        ))}
      </select>
      {parsed.target === "page" || parsed.target === "section" ? (
        <select
          disabled={disabled}
          aria-label="Page"
          value={parsed.pageId}
          onChange={(event) => setPageId(event.target.value)}
        >
          {targets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
      ) : null}
      {parsed.target === "section" ? (
        <select
          disabled={disabled || (page?.sections.length ?? 0) === 0}
          aria-label="Section"
          value={parsed.sectionId}
          onChange={(event) => setSectionId(event.target.value)}
        >
          {page === undefined || page.sections.length === 0 ? (
            <option value="">This page has no sections yet</option>
          ) : (
            page.sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))
          )}
        </select>
      ) : null}
      {parsed.target === "email" ? (
        <input
          type="email"
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          placeholder="owner@example.com"
          value={parsed.email}
          onChange={(event) => setEmail(event.target.value)}
        />
      ) : null}
    </div>
  );
}
