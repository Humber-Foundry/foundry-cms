import type { NextConfig } from "next";

import { dashboardContentSecurityPolicyHeaders } from "./src/dashboard-content-security-policy";
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
  // Every dashboard document may run scripts and open frames from the site's
  // own origin only, so no editing surface can reach a third party (#234).
  async headers() {
    return dashboardContentSecurityPolicyHeaders({
      development: process.env.NODE_ENV !== "production",
    });
  },
};

export default nextConfig;
