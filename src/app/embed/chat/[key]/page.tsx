import { WebsiteChatEmbed } from '@/features/website-chat/website-chat-embed';

/**
 * The website chat, framed by the dealer's own site through
 * /widget/v1/gdm-chat.js. Anonymous: it reads no session and renders no CRM
 * data. src/proxy.ts sets its CSP frame-ancestors from the connection's domains.
 */
export const metadata = { title: 'Chat', robots: { index: false, follow: false } };

export default async function WebsiteChatEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ key }, search] = await Promise.all([params, searchParams]);
  const page = typeof search.page === 'string' ? search.page.slice(0, 500) : undefined;
  return <WebsiteChatEmbed publicKey={key} pageUrl={page} />;
}
