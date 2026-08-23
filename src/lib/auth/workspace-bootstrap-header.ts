import { workspaceBootstrapSchema, type WorkspaceBootstrap } from '@/lib/auth/workspace-bootstrap';

export const WORKSPACE_BOOTSTRAP_HEADER = 'x-crm-workspace-bootstrap';

// Keep the internal request header comfortably below common proxy/header limits.
// The layout falls back to a direct RPC when an unusually large permission set
// cannot be forwarded safely.
const MAX_BOOTSTRAP_HEADER_BYTES = 6_000;

export function encodeWorkspaceBootstrapHeader(value: unknown) {
  const parsed = workspaceBootstrapSchema.safeParse(value);
  if (!parsed.success) return null;

  const encoded = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
  return Buffer.byteLength(encoded, 'ascii') <= MAX_BOOTSTRAP_HEADER_BYTES ? encoded : null;
}

export function decodeWorkspaceBootstrapHeader(value: string | null): WorkspaceBootstrap | null {
  if (!value || Buffer.byteLength(value, 'ascii') > MAX_BOOTSTRAP_HEADER_BYTES) return null;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = workspaceBootstrapSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
