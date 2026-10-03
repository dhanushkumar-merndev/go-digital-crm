export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const healthHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  Expires: '0',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

function healthPayload() {
  return {
    status: 'ok',
    service: 'go-digital-marketing-crm',
    timestamp: new Date().toISOString(),
  } as const;
}

export function GET() {
  return new Response(JSON.stringify(healthPayload()), {
    status: 200,
    headers: healthHeaders,
  });
}

export function HEAD() {
  return new Response(null, {
    status: 200,
    headers: healthHeaders,
  });
}
