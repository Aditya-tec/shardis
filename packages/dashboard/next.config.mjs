import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pins the workspace root to this package instead of letting Next.js
  // guess from whichever lockfile it finds highest up the filesystem.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url))
};

export default nextConfig;
