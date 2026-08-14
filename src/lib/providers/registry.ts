import type {
  CallProviderAdapter,
  EmailAdapter,
  LeadSourceAdapter,
  MessagingAdapter,
} from './contracts';

type ProviderAdapters = {
  leads?: LeadSourceAdapter;
  messaging?: MessagingAdapter;
  calls?: CallProviderAdapter;
  email?: EmailAdapter;
};

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapters>();

  register(providerKey: string, adapters: ProviderAdapters) {
    if (this.adapters.has(providerKey))
      throw new Error(`Provider adapter already registered: ${providerKey}`);
    this.adapters.set(providerKey, Object.freeze({ ...adapters }));
  }

  get(providerKey: string) {
    const adapter = this.adapters.get(providerKey);
    if (!adapter) throw new Error(`Unsupported provider adapter: ${providerKey}`);
    return adapter;
  }
}
