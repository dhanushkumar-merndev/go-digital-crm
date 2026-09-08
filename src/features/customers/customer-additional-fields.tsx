'use client';
import { useQuery } from '@tanstack/react-query';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchCustomerAdditionalFields } from './customer-workspace-api';

export function CustomerAdditionalFields({ customerId }: { customerId: string }) {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['customer-360', ...workspaceQueryScope(session), customerId, 'additional-fields'],
    queryFn: ({ signal }) => fetchCustomerAdditionalFields(customerId, signal),
    staleTime: 60000,
  });
  if (query.isPending)
    return <p className="text-sm text-muted-foreground">Loading additional details…</p>;
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Additional customer fields could not be loaded.
      </p>
    );
  if (!query.data.length) return null;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Additional customer fields</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          {query.data.map((field) => (
            <div key={field.label}>
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{field.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
