import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Permit the CRM to be opened from this LAN host while running `next dev`.
  // Next.js expects host names here, not a protocol or port.
  allowedDevOrigins: [
    '192.168.1.20',
    '192.168.1.11',
    '192.168.1.18',
    '192.168.1.9',
    '192.168.1.16',
  ],
};

export default nextConfig;
