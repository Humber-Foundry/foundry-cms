import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AccessDeniedError } from "@foundry/application";

import { SiteRenderer } from "@/components/site-renderer";
import { AccessIdentityError } from "@/src/access-identity";
import { loadContentRevisionApplication } from "@/src/content-revision-runtime";
import { HumanAccessConfigurationError } from "@/src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "@/src/human-access-runtime";

import "../../public.css";
import "./preview.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Saved revision preview",
};

export default async function RevisionPreviewPage({
  params,
}: {
  params: Promise<{ revision: string }>;
}) {
  const { revision: revisionParameter } = await params;
  const revisionNumber = Number(revisionParameter);
  if (
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 0 ||
    String(revisionNumber) !== revisionParameter
  ) {
    notFound();
  }

  try {
    const identity = await loadHumanIdentityRequestContext(await headers());
    const access = await authorizeAuthenticatedHumanIdentity(identity);
    if (access.state !== "authorized") {
      notFound();
    }
  } catch (error) {
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanAccessConfigurationError
    ) {
      notFound();
    }
    throw error;
  }

  const revision = await (
    await loadContentRevisionApplication()
  ).queries.getRevision(revisionNumber);
  if (revision === null) {
    notFound();
  }

  return (
    <>
      <aside className="preview-provenance" aria-label="Preview provenance">
        <div>
          <strong>Exact saved preview · revision {revision.revision}</strong>
          <span>Created {revision.createdAt}</span>
        </div>
        <dl>
          <div>
            <dt>Content</dt>
            <dd>{revision.inputs.contentHash}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{revision.inputs.schemaVersion}</dd>
          </div>
          <div>
            <dt>Renderer</dt>
            <dd>{revision.inputs.rendererVersion}</dd>
          </div>
          <div>
            <dt>Production base</dt>
            <dd>{revision.inputs.productionBase}</dd>
          </div>
        </dl>
        <a href="/dash">Return to editor</a>
      </aside>
      <SiteRenderer definition={revision.definition} />
    </>
  );
}
