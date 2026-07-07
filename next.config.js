/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse"],
  },
  webpack: (config) => {
    // pdfjs-dist optionally requires the native "canvas" module for Node; the
    // browser doesn't need it. Stub it so the client bundle builds cleanly.
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
};

module.exports = nextConfig;
