import { describe, expect, it } from 'vitest';
import {
  isDevelopmentPreviewEnabled,
  resolveRuntimeMode,
} from '../../src/lib/runtime/runtime-mode';

describe('runtime access mode', () => {
  it('enables preview only for an explicit development build flag', () => {
    expect(isDevelopmentPreviewEnabled({ nodeEnv: 'development', previewFlag: 'true' })).toBe(true);
    expect(isDevelopmentPreviewEnabled({ nodeEnv: 'development', previewFlag: undefined })).toBe(
      false,
    );
    expect(isDevelopmentPreviewEnabled({ nodeEnv: 'development', previewFlag: 'TRUE' })).toBe(
      false,
    );
  });

  it('ignores the public preview flag in production', () => {
    expect(
      resolveRuntimeMode({
        nodeEnv: 'production',
        previewFlag: 'true',
        hasSupabaseConfig: false,
      }),
    ).toBe('MISCONFIGURED');
  });

  it('fails closed when preview is disabled and Supabase is missing', () => {
    expect(
      resolveRuntimeMode({
        nodeEnv: 'development',
        previewFlag: 'false',
        hasSupabaseConfig: false,
      }),
    ).toBe('MISCONFIGURED');
  });

  it('uses authenticated runtime mode when Supabase is configured', () => {
    expect(
      resolveRuntimeMode({
        nodeEnv: 'production',
        previewFlag: 'true',
        hasSupabaseConfig: true,
      }),
    ).toBe('CONFIGURED');
  });

  it('prefers explicit preview over configured services during local development', () => {
    expect(
      resolveRuntimeMode({
        nodeEnv: 'development',
        previewFlag: 'true',
        hasSupabaseConfig: true,
      }),
    ).toBe('LOCAL_PREVIEW');
  });
});
