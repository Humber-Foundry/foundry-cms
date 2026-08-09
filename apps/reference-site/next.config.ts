import type { NextConfig } from "next";

import { privatePreviewHostname } from "./src/private-preview-origin";

const allowedPrivatePreviewHost = privatePreviewHostname(
  process.env.FOUNDRY_PRIVATE_PREVIEW_ORIGIN,
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: [allowedPrivatePreviewHost],
  env: {
    FOUNDRY_RELEASE_COMMIT_SHA:
      process.env.WORKERS_CI_COMMIT_SHA ??
      process.env.FOUNDRY_RELEASE_COMMIT_SHA ??
      "",
  },
  transpilePackages: [
    "@humber-foundry/application",
    "@humber-foundry/site-definition",
  ],
};

export default nextConfig;
