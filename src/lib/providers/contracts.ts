export type AdapterContext = {
  organizationId: string;
  connectionId: string;
  requestId: string;
  branchMappings: ReadonlyArray<{ externalResourceId: string; branchId: string }>;
};

export type ConnectionTestResult =
  { ok: true; accountLabel: string } | { ok: false; safeCode: string; safeMessage: string };
export type CanonicalLeadInput = {
  source:
    | 'Facebook'
    | 'Instagram'
    | 'Google Ads'
    | 'Website'
    | 'WhatsApp Business'
    | 'CarWale'
    | 'CarDekho'
    | 'Justdial'
    | 'IndiaMART'
    | 'Manual'
    | 'Other';
  customerName: string;
  phone: string;
  email?: string;
  location?: string;
  campaign?: string;
  interestedModel?: string;
  preferredBranchId?: string;
  sourceDetail?: string;
  externalLeadId?: string;
};
export type PullResult = { leads: CanonicalLeadInput[]; nextCursor?: string };
export type SendMessageInput = {
  conversationId: string;
  recipient: string;
  body: string;
  templateId?: string;
};
export type ProviderMessageResult = { providerMessageId: string; acceptedAt: string };
export type CanonicalMessage = {
  providerMessageId: string;
  externalThreadId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  sentAt: string;
};
export type ProviderCallRef = { providerCallId: string };
export type ProviderCallResult = {
  providerCallId: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
};
export type ProviderRecordingRef = { temporaryUrl: string; expiresAt: string; mimeType: string };
export type ProviderTranscript = { text: string; language?: string };
export type EmailInput = {
  recipient: string;
  templateId: string;
  variables: Record<string, string>;
  idempotencyKey: string;
};
export type EmailResult = { providerMessageId: string; acceptedAt: string };

export interface LeadSourceAdapter {
  testConnection(connectionId: string): Promise<ConnectionTestResult>;
  normalizeWebhook(input: unknown, context: AdapterContext): Promise<CanonicalLeadInput[]>;
  pullLeads?(cursor?: string): Promise<PullResult>;
}

export interface MessagingAdapter {
  sendMessage(input: SendMessageInput): Promise<ProviderMessageResult>;
  normalizeInbound(input: unknown, context: AdapterContext): Promise<CanonicalMessage[]>;
}

export interface CallProviderAdapter {
  startCall?(input: { to: string; fromUserId: string }): Promise<ProviderCallRef>;
  fetchCall(providerCallId: string): Promise<ProviderCallResult>;
  fetchRecording?(providerCallId: string): Promise<ProviderRecordingRef>;
  fetchTranscript?(providerCallId: string): Promise<ProviderTranscript>;
}

export interface EmailAdapter {
  send(input: EmailInput): Promise<EmailResult>;
}
export interface MapsAdapter {
  geocode(address: string): Promise<{ latitude: number; longitude: number }>;
  route(
    points: ReadonlyArray<{ latitude: number; longitude: number }>,
  ): Promise<{ distanceMeters: number; durationSeconds: number; encodedPolyline: string }>;
}
export interface AIAdapter {
  transcribe(objectFileId: string): Promise<ProviderTranscript>;
  summarize(transcript: string): Promise<{ summary: string }>;
  extractFields(transcript: string): Promise<Record<string, unknown>>;
}
