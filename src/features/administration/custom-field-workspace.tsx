'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import {
  createCustomField,
  customFieldPageSizes,
  customFieldStatuses,
  customFieldTypes,
  fetchCustomFieldPage,
  setCustomFieldActive,
  type CustomFieldPageSize,
  type CustomFieldStatus,
  type CustomFieldType,
} from './custom-field-workspace-api';

function requestId() {
  return globalThis.crypto.randomUUID();
}

function CreateFieldDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [module, setModule] = useState('CUSTOMERS');
  const [fieldKey, setFieldKey] = useState('');
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('TEXT');
  const [optionsText, setOptionsText] = useState('');
  const [required, setRequired] = useState(false);
  const [id, setId] = useState(requestId);
  const selectable = fieldType === 'SELECT' || fieldType === 'MULTI_SELECT';
  const options = optionsText
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const mutation = useMutation({
    mutationFn: () =>
      createCustomField({
        module,
        fieldKey,
        label,
        fieldType,
        options: selectable ? options : [],
        required,
        requestId: id,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Custom field created',
        description: 'The definition is now available in its CRM module.',
      });
      void queryClient.invalidateQueries({ queryKey: ['custom-field-administration'] });
      setFieldKey('');
      setLabel('');
      setOptionsText('');
      setRequired(false);
      setId(requestId());
      onOpenChange(false);
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Could not create custom field',
        description: 'Check the field key, options and your organization scope.',
      }),
  });
  const valid =
    /^[a-z][a-z0-9_]{1,62}$/.test(fieldKey) &&
    label.trim().length >= 2 &&
    (!selectable || options.length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create custom field</DialogTitle>
          <DialogDescription>
            Definitions apply across the organization and are audited.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) mutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Label className="grid gap-1.5">
              Module
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'CUSTOMERS',
                    'LEADS',
                    'BOOKINGS',
                    'FINANCE',
                    'INSURANCE',
                    'RTO',
                    'EXCHANGE',
                    'DELIVERY',
                  ].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-1.5">
              Field type
              <Select
                value={fieldType}
                onValueChange={(value) => setFieldType(value as CustomFieldType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {customFieldTypes.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </div>
          <Label className="grid gap-1.5">
            Label
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={120}
              placeholder="Preferred fuel type"
            />
          </Label>
          <Label className="grid gap-1.5">
            Field key
            <Input
              value={fieldKey}
              onChange={(event) =>
                setFieldKey(event.target.value.toLowerCase().replace(/\s+/g, '_'))
              }
              maxLength={63}
              placeholder="preferred_fuel_type"
            />
            <span className="text-xs font-normal text-muted-foreground">
              Lowercase letters, numbers and underscores only.
            </span>
          </Label>
          {selectable ? (
            <Label className="grid gap-1.5">
              Options
              <Textarea
                value={optionsText}
                onChange={(event) => setOptionsText(event.target.value)}
                placeholder={'Petrol\nDiesel\nElectric'}
              />
              <span className="text-xs font-normal text-muted-foreground">
                One option per line.
              </span>
            </Label>
          ) : null}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 rounded border-input accent-primary"
              checked={required}
              onChange={(event) => setRequired(event.target.checked)}
            />
            Required when this field is shown
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              Create field
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CustomFieldWorkspace({ spec }: { spec: PageSpec }) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [status, setStatus] = useState<CustomFieldStatus>('ALL');
  const [pageSize, setPageSize] = useState<CustomFieldPageSize>(25);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => setPage(1), [search, status, pageSize]);
  const query = useQuery({
    queryKey: ['custom-field-administration', search, status, page, pageSize],
    queryFn: ({ signal }) => fetchCustomFieldPage({ search, status, page, pageSize, signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean; version: number }) =>
      setCustomFieldActive({ ...input, requestId: requestId() }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['custom-field-administration'] }),
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Could not change field status',
        description: 'The definition may have changed. Refresh and try again.',
      }),
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="shadow-none">
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Custom fields require organization-wide administration access.
        </CardContent>
      </Card>
    );
  const pages = Math.max(1, Math.ceil(query.data.total / pageSize));
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">
            Administration › CRM configuration
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage validated organization-wide CRM fields without modifying existing customer data.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="size-4" /> Create field
        </Button>
      </div>
      <KpiGrid
        metrics={[
          {
            label: 'Total definitions',
            value: query.data.total.toLocaleString(),
            icon: SlidersHorizontal,
          },
          {
            label: 'Active',
            value: query.data.active_count.toLocaleString(),
            icon: SlidersHorizontal,
          },
          {
            label: 'Inactive',
            value: query.data.inactive_count.toLocaleString(),
            icon: SlidersHorizontal,
          },
        ]}
      />
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search label, key or module"
            />
          </div>
          <Select value={status} onValueChange={(value) => setStatus(value as CustomFieldStatus)}>
            <SelectTrigger className="md:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {customFieldStatuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === 'ALL' ? 'All statuses' : value[0] + value.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => setPageSize(Number(value) as CustomFieldPageSize)}
          >
            <SelectTrigger className="md:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {customFieldPageSizes.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base">Field definitions</CardTitle>
          <CardDescription>
            Server-side search and pagination · read carefully before deactivating a field.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Label / key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <Badge variant="outline">{record.module}</Badge>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{record.label}</p>
                    <p className="font-mono text-xs text-muted-foreground">{record.field_key}</p>
                  </TableCell>
                  <TableCell>{record.field_type.replace('_', ' ')}</TableCell>
                  <TableCell>{record.required ? 'Required' : 'Optional'}</TableCell>
                  <TableCell>
                    <Badge variant={record.active ? 'success' : 'secondary'}>
                      {record.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() =>
                        toggle.mutate({
                          id: record.id,
                          active: !record.active,
                          version: record.version,
                        })
                      }
                    >
                      {record.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!query.data.records.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-sm text-muted-foreground">
                    No custom field definitions match this filter.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || query.isFetching}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft className="size-4" /> Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {page} of {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages || query.isFetching}
          onClick={() => setPage((value) => value + 1)}
        >
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
      <CreateFieldDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
