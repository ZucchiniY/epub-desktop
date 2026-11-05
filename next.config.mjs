/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.NODE_ENV === "development" ? {} : { output: "export" }),
  ...(process.env.TAURI_BUILD === "1" ? { trailingSlash: true } : {}),
  images: { unoptimized: true },
  experimental: {
    agentUpgrade: "security",
  },
};

export default nextConfig;
