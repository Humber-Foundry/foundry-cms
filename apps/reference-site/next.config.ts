import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    FOUNDRY_RELEASE_COMMIT_SHA:
      process.env.WORKERS_CI_COMMIT_SHA ??
      process.env.FOUNDRY_RELEASE_COMMIT_SHA ??
      "",
  },
  transpilePackages: [
    "@foundry/application",
    "@foundry/site-definition",
  ],
};

export default nextConfig;
