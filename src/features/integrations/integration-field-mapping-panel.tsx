'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Waypoints } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import {
  fetchIntegrationFieldMappings,
  getFieldMappingErrorMessage,
  integrationFieldMappingKey,
  saveIntegrationFieldMappings,
} from './integration-field-mapping-api';

type Row = { external_field: string; canonical_field: string };

/** Human labels for the canonical targets CanonicalLeadInput accepts. */
const fieldLabels: Record<string, string> = {
  source: 'Lead source',
  customerName: 'Customer name',
  phone: 'Phone',
  email: 'Email',
  location: 'Location',
  campaign: 'Campaign',
  interestedModel: 'Interested model',
  preferredBranchId: 'Preferred branch',
  sourceDetail: 'Source detail',
  externalLeadId: 'External lead ID',
};

export function IntegrationFieldMappingPanel({ connectionId }: { connectionId: string }) {
  const mapping = useQuery({
    queryKey: integrationFieldMappingKey(connectionId),
    queryFn: ({ signal }) => fetchIntegrationFieldMappings(connectionId, signal),
    staleTime: 60_000,
  });
  if (mapping.isPending) return null;
  if (mapping.isError)
    return (
      <Alert>
        <AlertTitle>Field mapping is unavailable</AlertTitle>
        <AlertDescription>
          Confirm integration management access for this connection.
        </AlertDescription>
      </Alert>
    );
  // Keyed on the connection so switching connections seeds a fresh editor
  // rather than syncing state back out of an effect.
  return (
    <FieldMappingEditor
      key={connectionId}
      connectionId={connectionId}
      canonicalFields={mapping.data.canonical_fields}
      initialRows={mapping.data.mappings.map((item) => ({
        external_field: item.external_field,
        canonical_field: item.canonical_field,
      }))}
    />
  );
}

function FieldMappingEditor({
  connectionId,
  canonicalFields,
  initialRows,
}: {
  connectionId: string;
  canonicalFields: string[];
  initialRows: Row[];
}) {
  const client = useQueryClient();
  // Edits are local until saved, because the RPC replaces the whole set rather
  // than patching one row.
  const [rows, setRows] = useState<Row[]>(initialRows);

  const save = useMutation({
    mutationFn: saveIntegrationFieldMappings,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: 'Field mapping saved',
        description: `${result.mapping_count} column${result.mapping_count === 1 ? '' : 's'} mapped for incoming leads.`,
      });
      void client.invalidateQueries({ queryKey: integrationFieldMappingKey(connectionId) });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Field mapping was not saved',
        description: getFieldMappingErrorMessage(error),
      }),
  });

  const duplicate =
    new Set(rows.map((row) => row.external_field.trim()).filter(Boolean)).size !==
    rows.filter((row) => row.external_field.trim()).length;
  const incomplete = rows.some((row) => !row.external_field.trim() || !row.canonical_field);

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Waypoints className="size-4 text-blue-600" /> Lead field mapping
        </CardTitle>
        <CardDescription>
          Map this ads account&apos;s own column names onto CRM fields. Anything left unmapped is
          not ingested.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              value={row.external_field}
              maxLength={200}
              placeholder="Their column, e.g. FULL_NAME"
              aria-label={`Ads column ${index + 1}`}
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, position) =>
                    position === index ? { ...item, external_field: event.target.value } : item,
                  ),
                )
              }
            />
            <span className="text-muted-foreground">→</span>
            <Select
              value={row.canonical_field}
              onValueChange={(value) =>
                setRows((current) =>
                  current.map((item, position) =>
                    position === index ? { ...item, canonical_field: value } : item,
                  ),
                )
              }
            >
              <SelectTrigger className="w-56" aria-label={`CRM field ${index + 1}`}>
                <SelectValue placeholder="CRM field" />
              </SelectTrigger>
              <SelectContent>
                {canonicalFields.map((field) => (
                  <SelectItem key={field} value={field}>
                    {fieldLabels[field] ?? field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={`Remove mapping ${index + 1}`}
              onClick={() => setRows((current) => current.filter((_, p) => p !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {duplicate && (
          <p className="text-xs text-destructive">
            Two rules point at the same ads column. Give each column one target field.
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rows.length >= 100}
            onClick={() =>
              setRows((current) => [...current, { external_field: '', canonical_field: '' }])
            }
          >
            <Plus /> Add column
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || duplicate || incomplete}
            onClick={() => save.mutate({ connectionId, mappings: rows })}
          >
            {save.isPending ? 'Saving…' : 'Save mapping'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
