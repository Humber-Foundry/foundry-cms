import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@foundry/application",
    "@foundry/site-definition",
  ],
};

export default nextConfig;
