import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ functions: { invoke } }) }));
import { checkPersonalWhatsAppAvailability } from '../../src/features/inbox/personal-whatsapp-api';

describe('WhatsApp availability before opening connection dialog', () => {
  beforeEach(() => invoke.mockReset());
  it('accepts a healthy backend with no account linked yet', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, data: { available: true, status: null } },
      error: null,
    });
    expect(await checkPersonalWhatsAppAvailability()).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      'personal-whatsapp-availability',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('rejects an unavailable backend even if its response is successful HTTP', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, data: { available: false, status: null } },
      error: null,
    });
    await expect(checkPersonalWhatsAppAvailability()).rejects.toThrow(
      'PERSONAL_WHATSAPP_GATEWAY_UNAVAILABLE',
    );
  });
  it('fails closed for a missing function or timeout', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('Request failed') });
    await expect(checkPersonalWhatsAppAvailability()).rejects.toThrow();
  });
  it('rejects a malformed status instead of opening with misleading state', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, data: { available: true, status: {} } },
      error: null,
    });
    await expect(checkPersonalWhatsAppAvailability()).rejects.toThrow();
  });
});
