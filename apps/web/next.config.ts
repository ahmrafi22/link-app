import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phase ⑦ — the IG audio transcript path shells out to the ffmpeg binary;
  // keep the package unbundled and trace the binary into API lambdas
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
