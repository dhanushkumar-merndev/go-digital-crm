/**
 * Legacy Justdial / CarWale / CarDekho / IndiaMART connect form (vendor ID +
 * API key + push webhook URL). Hidden on 2026-10-10 when these portals moved to
 * the email-inbox connection; the form, the `integration-connect-<portal>` and
 * `provider-webhook-<portal>` Edge Functions and the adapters are all kept, and
 * webhook connections already live keep receiving leads.
 *
 * Set to `true` to offer the webhook method again next to the email inbox.
 */
export const PORTAL_WEBHOOK_CONNECT_ENABLED = false;
