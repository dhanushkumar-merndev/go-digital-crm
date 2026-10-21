'use client';

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, humanizeEnum } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';
import { readRpc } from '@/lib/supabase/read-rpc';

const departmentSchema = z.enum(['FINANCE', 'INSURANCE', 'RTO', 'EXCHANGE', 'DELIVERY']);
const operationalCasesSchema = z.object({
  departments: z.array(departmentSchema),
  cases: z.array(
    z.object({
      department: departmentSchema,
      id: z.uuid(),
      booking_id: z.uuid().nullable(),
      booking_number: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      due_at: z.string().nullable(),
      updated_at: z.string(),
    }),
  ),
});
export type CustomerOperationalCases = z.infer<typeof operationalCasesSchema>;

async function fetchCustomerOperationalCases(customerId: string, signal?: AbortSignal) {
  const data = await readRpc(
    createClient().rpc('get_customer_operational_cases', { target_customer_id: customerId }),
    signal,
  );
  return operationalCasesSchema.parse(data);
}

/**
 * Finance, insurance, RTO, exchange and delivery progress for one customer
 * (AGENTS.md 9.5 / PRD 54.7 §66). The server applies each desk's read policy,
 * so `departments` lists only the desks this user may see; the tab is hidden
 * when there are none.
 */
export function useCustomerOperationalCases(customerId: string) {
  const session = useWorkspaceSession();
  return useQuery({
    queryKey: ['customer-operational-cases', ...workspaceQueryScope(session), customerId],
    queryFn: ({ signal }) => fetchCustomerOperationalCases(customerId, signal),
    staleTime: 60_000,
    retry: 1,
  });
}

const departmentLabels: Record<CustomerOperationalCases['departments'][number], string> = {
  FINANCE: 'Finance',
  INSURANCE: 'Insurance',
  RTO: 'RTO',
  EXCHANGE: 'Exchange',
  DELIVERY: 'Delivery',
};

export function CustomerOperationsPanel({
  query,
}: {
  query: ReturnType<typeof useCustomerOperationalCases>;
}) {
  if (query.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (query.isError || !query.data)
    return (
      <ErrorState
        title="Operations are unavailable"
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  const { cases, departments } = query.data;
  if (!cases.length)
    return (
      <EmptyState
        title="No operational cases yet"
        description={`Cases appear here once a booking moves to ${departments
          .map((department) => departmentLabels[department])
          .join(', ')}.`}
      />
    );
  return (
    <Card className="overflow-hidden shadow-none">
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>Booking</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.map((record) => (
              <TableRow key={`${record.department}:${record.id}`}>
                <TableCell className="font-medium">{departmentLabels[record.department]}</TableCell>
                <TableCell className="font-mono text-xs">
                  #{record.id.slice(0, 8).toUpperCase()}
                </TableCell>
                <TableCell>{record.booking_number ?? '—'}</TableCell>
                <TableCell>
                  <StatusBadge value={record.status} />
                </TableCell>
                <TableCell>{humanizeEnum(record.priority)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {record.due_at ? formatDateTime(record.due_at) : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(record.updated_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
