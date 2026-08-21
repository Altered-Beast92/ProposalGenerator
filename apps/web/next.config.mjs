/** @type {import('next').NextConfig} */
const nextConfig = {
  // The renderer lives outside this app and is spawned as a child process, so
  // nothing here should be bundled or traced beyond the app directory.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
