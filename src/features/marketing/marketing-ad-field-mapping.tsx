'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IntegrationFieldMappingPanel } from '@/features/integrations/integration-field-mapping-panel';
import { adMappableLeadFields } from '@/lib/providers/lead-field-mapping';
import {
  fetchMarketingLeadSourceConnections,
  marketingLeadSourceConnectionsKey,
} from './marketing-campaign-api';

const providerLabels: Record<string, string> = {
  meta: 'Meta Lead Ads',
  google_ads: 'Google Ads',
  indiamart: 'IndiaMART',
  carwale: 'CarWale',
  cardekho: 'CarDekho',
  justdial: 'Justdial',
};

/** Lets a marketing manager map each ad account's form columns onto CRM lead
 * fields. Connecting accounts and credentials stay with integration admins. */
export function MarketingAdFieldMapping() {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: marketingLeadSourceConnectionsKey,
    queryFn: ({ signal }) => fetchMarketingLeadSourceConnections(signal),
  });
  const [selectedId, setSelectedId] = useState('');

  if (connections.isPending || connections.isError || !connections.data.can_map) return null;
  const list = connections.data.connections;
  const selected = list.find((item) => item.id === selectedId) ?? list[0];

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <Card className="shadow-none xl:col-span-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Waypoints className="size-4 text-blue-600" /> Ad column mapping
          </CardTitle>
          <CardDescription>
            Choose an ad account, then map its form columns to CRM lead fields. Accounts are
            connected by your integration admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No ad lead-source account is connected in your scope yet.
            </p>
          ) : (
            <>
              <Select value={selected?.id ?? ''} onValueChange={setSelectedId}>
                <SelectTrigger aria-label="Ad account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ul className="divide-y rounded-md border text-sm">
                {list.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{item.display_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {providerLabels[item.provider_key] ?? item.provider_key}
                      </span>
                    </span>
                    <Badge variant={item.mapping_count > 0 ? 'success' : 'warning'}>
                      {item.mapping_count > 0 ? `${item.mapping_count} mapped` : 'Default columns'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
      <div className="xl:col-span-7">
        {selected ? (
          <IntegrationFieldMappingPanel
            connectionId={selected.id}
            allowedFields={adMappableLeadFields}
            onSaved={() =>
              void queryClient.invalidateQueries({ queryKey: marketingLeadSourceConnectionsKey })
            }
          />
        ) : null}
      </div>
    </div>
  );
}
