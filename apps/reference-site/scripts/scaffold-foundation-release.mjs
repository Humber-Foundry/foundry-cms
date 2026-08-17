#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLockedReleaseExecutable,
  isTemplatePath,
  parseReleaseArguments,
  tarEntries,
  writeInstallationBuildConfiguration,
} from "./foundation-release-lib.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2), {
    required: ["target", "descriptor", "descriptor-digest", "artifacts"],
  });
  const target = resolve(options.target);
  const artifactDirectory = resolve(options.artifacts);
  const descriptorPath = resolve(options.descriptor);
  const descriptorSource = await readFile(descriptorPath, "utf8");
  const actualDescriptorDigest = Buffer.from(
    `sha256:${createHash("sha256").update(descriptorSource).digest("hex")}`,
  );
  const expectedDescriptorDigest = Buffer.from(options["descriptor-digest"]);
  if (
    actualDescriptorDigest.length !== expectedDescriptorDigest.length ||
    !timingSafeEqual(actualDescriptorDigest, expectedDescriptorDigest)
  ) {
    throw new Error("foundation_release_descriptor_digest_mismatch");
  }
  const untrustedDescriptor = JSON.parse(descriptorSource);
  const lock = JSON.parse(await readFile(join(target, "package-lock.json"), "utf8"));
  for (const name of ["@humber-foundry/operator", "@humber-foundry/reference-site"]) {
    assertLockedReleaseExecutable({ descriptor: untrustedDescriptor, lock, name });
  }
  const {
    loadFoundationReleaseDescriptor,
    verifyFoundationReleaseArtifacts,
  } = await import("@humber-foundry/operator");
  const descriptor = await loadFoundationReleaseDescriptor({
    descriptorPath,
    expectedDigest: options["descriptor-digest"],
  });
  const artifactBytes = new Map();
  await verifyFoundationReleaseArtifacts({
    descriptor,
    readArtifact: async (filename) => {
      const bytes = await readFile(join(artifactDirectory, filename));
      artifactBytes.set(filename, bytes);
      return bytes;
    },
  });

  const referenceArtifact = descriptor.artifacts["@humber-foundry/reference-site"];
  const entries = tarEntries(artifactBytes.get(referenceArtifact.filename));
  for (const [path, bytes] of entries) {
    if (!isTemplatePath(path)) continue;
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }

  const publishedSitePath = join(target, "foundry/published-site.json");
  const packagedSite = JSON.parse(
    await readFile(publishedSitePath, "utf8"),
  );
  const emptyProductionSite = {
    ...packagedSite,
    site: {
      ...packagedSite.site,
      id: "site_client_installation",
      name: "Foundry site",
      description: "Client-owned content managed with Foundry CMS.",
      // A scaffolded installation has no address of its own yet. It must
      // never inherit the packaged site's, or its pages would name the wrong
      // host in every canonical and share URL.
      canonicalOrigin: "",
      navigation: [],
      footer: "Powered by Foundry CMS.",
    },
    home: {
      ...packagedSite.home,
      seo: {
        title: "Foundry site",
        description: "Client-owned content managed with Foundry CMS.",
        keywords: [],
        shareImage: null,
      },
      sections: [],
    },
    ...(packagedSite.blog === undefined
      ? {}
      : { blog: { ...packagedSite.blog, posts: [] } }),
  };
  await writeFile(
    publishedSitePath,
    `${JSON.stringify(emptyProductionSite, null, 2)}\n`,
  );

  await writeInstallationBuildConfiguration({ target, descriptor, packageRoot });
  await writeFile(
    join(target, ".foundry-foundation-release.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
