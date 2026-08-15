import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InviteSessionAcceptor } from '@/features/auth/invite-session-acceptor';

export default function InvitePage() {
  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <CardTitle>Accept your invitation</CardTitle>
          <CardDescription>
            The invitation is one-time and will be exchanged for your secure account session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteSessionAcceptor />
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
