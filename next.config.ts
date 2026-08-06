import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // geo-tz loads timezone boundary data from its own package directory at
  // runtime. Bundling it rewrites those paths and the lookup silently returns
  // nothing, so it has to stay external and be traced as a real node_module.
  serverExternalPackages: ["geo-tz"],

  typedRoutes: true,
};

export default nextConfig;
