export type RuntimeMode = 'LOCAL_PREVIEW' | 'CONFIGURED' | 'MISCONFIGURED';

export type RuntimeModeInput = {
  nodeEnv: string | undefined;
  previewFlag: string | undefined;
  hasSupabaseConfig: boolean;
};

export function isDevelopmentPreviewEnabled({
  nodeEnv,
  previewFlag,
}: Pick<RuntimeModeInput, 'nodeEnv' | 'previewFlag'>) {
  return nodeEnv === 'development' && previewFlag === 'true';
}

export function resolveRuntimeMode(input: RuntimeModeInput): RuntimeMode {
  if (isDevelopmentPreviewEnabled(input)) return 'LOCAL_PREVIEW';
  return input.hasSupabaseConfig ? 'CONFIGURED' : 'MISCONFIGURED';
}

export function getRuntimeMode(): RuntimeMode {
  return resolveRuntimeMode({
    nodeEnv: process.env.NODE_ENV,
    previewFlag: process.env.NEXT_PUBLIC_ENABLE_LOCAL_PREVIEW,
    hasSupabaseConfig: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
  });
}

export function isLocalPreviewMode() {
  return getRuntimeMode() === 'LOCAL_PREVIEW';
}
