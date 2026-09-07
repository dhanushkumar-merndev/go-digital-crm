import { PublicFeedbackForm } from '@/features/feedback/public-feedback-form';

/**
 * The only unauthenticated page in the application. It carries no session and
 * reads nothing but the token in the path, so it is excluded from indexing and
 * never renders customer details.
 */
export const metadata = { title: 'Share your feedback', robots: { index: false, follow: false } };

export default async function PublicFeedbackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicFeedbackForm token={token} />;
}
