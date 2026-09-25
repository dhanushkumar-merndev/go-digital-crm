'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { toast } from '@/components/ui/toast';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { fetchLeadCreateOptions } from './lead-workspace-api';
import {
  fetchLeadBulkImport,
  leadBulkImportErrorMessage,
  submitLeadBulkImport,
} from './lead-bulk-import-api';
import {
  LEAD_BULK_IMPORT_MAX_BYTES,
  leadBulkImportTemplate,
  parseLeadBulkImportCsv,
  type LeadBulkImportPreview,
} from './lead-bulk-import-csv';

const activeStatuses = new Set(['QUEUED', 'PROCESSING', 'RETRY']);

const rowErrorLabels: Record<string, string> = {
  PERMISSION_DENIED: 'Permission changed before this row was processed.',
  SCOPE_DENIED: 'The selected branch is outside your current scope.',
  SALES_CONSULTANT_TEAM_REQUIRED: 'You are not assigned to an active team.',
  ASSIGNED_LEAD_REQUIRES_TEAM: 'An assigned lead requires an active team.',
  LEAD_TEAM_NOT_IN_BRANCH: 'Your active team is not in this branch.',
  NO_ELIGIBLE_FRESH_ASSIGNEE: 'No eligible Telecaller is available.',
  FRESH_ASSIGNMENT_REQUIRES_TELECALLER: 'Fresh leads must be assigned to a Telecaller.',
  BULK_IMPORT_ROW_FAILED: 'The row could not be imported.',
};

function downloadTemplate() {
  const url = URL.createObjectURL(
    new Blob([leadBulkImportTemplate], { type: 'text/csv;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'telecaller-lead-import-template.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function statusLabel(status: string) {
  return status
    .toLocaleLowerCase()
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export function LeadBulkImportDialog({
  organizationId,
  open,
  onOpenChange,
  onImported,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const fileInput = useRef<HTMLInputElement>(null);
  const completedImport = useRef<string | null>(null);
  const [branchId, setBranchId] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<LeadBulkImportPreview | null>(null);
  const [requestId, setRequestId] = useState('');
  const [importId, setImportId] = useState<string | null>(null);

  const options = useQuery({
    queryKey: ['lead-create-options', ...queryScope, organizationId],
    queryFn: ({ signal }) => fetchLeadCreateOptions(signal),
    enabled: open,
    staleTime: 60_000,
  });
  const selectedBranchId = branchId || options.data?.branches[0]?.id || '';
  const invalidRows = preview?.rows.filter((row) => row.errors.length > 0) ?? [];
  const validRows = preview?.rows.filter((row) => row.errors.length === 0) ?? [];
  const hasValidationErrors = Boolean(preview?.errors.length || invalidRows.length);

  const submit = useMutation({
    mutationFn: () =>
      submitLeadBulkImport({
        organizationId,
        branchId: selectedBranchId,
        fileName,
        requestId,
        rows: validRows.map((row) => row.values),
      }),
    onSuccess: (result) => {
      setImportId(result.id);
      toast.add({
        type: 'success',
        title: 'Lead import queued',
        description: `${result.total_rows} rows are being processed in the background.`,
      });
    },
  });

  const status = useQuery({
    queryKey: ['lead-bulk-import', importId],
    queryFn: ({ signal }) => fetchLeadBulkImport(importId!, signal),
    enabled: Boolean(importId),
    refetchInterval: (query) =>
      activeStatuses.has(query.state.data?.status ?? '') ? 2_000 : false,
  });

  useEffect(() => {
    const result = status.data;
    if (
      !result ||
      !['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(result.status) ||
      completedImport.current === result.id
    )
      return;
    completedImport.current = result.id;
    if (result.imported_rows > 0) onImported();
  }, [onImported, status.data]);

  const previewRows = useMemo(() => preview?.rows.slice(0, 25) ?? [], [preview]);

  const reset = () => {
    setFileName('');
    setPreview(null);
    setRequestId('');
    setImportId(null);
    submit.reset();
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Telecaller leads</DialogTitle>
          <DialogDescription>
            Download the CSV template, keep the header names unchanged, and upload up to 250 leads.
            Required columns are customer_name, phone and source.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-4">
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">1. Download the template</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Supported sources: Facebook, Instagram, Google Ads, Website, WhatsApp Business,
                CarWale, CarDekho, Justdial, IndiaMART, Manual and Other.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={downloadTemplate}>
              <Download className="size-4" /> Download CSV
            </Button>
          </div>

          {(options.data?.branches.length ?? 0) > 1 ? (
            <div className="grid max-w-sm gap-1.5 text-sm font-medium">
              Destination branch
              <Select value={selectedBranchId} onValueChange={setBranchId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {options.data?.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                Imported leads remain assigned to you and follow your active team configuration.
              </span>
            </div>
          ) : null}

          {!importId ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">2. Select and validate the completed CSV</p>
              <Input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                disabled={submit.isPending}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setFileName(file.name);
                  setRequestId(crypto.randomUUID());
                  setImportId(null);
                  if (!file.name.toLocaleLowerCase().endsWith('.csv')) {
                    setPreview({
                      rows: [],
                      errors: ['Choose a .csv file created from the template.'],
                    });
                    return;
                  }
                  if (file.size > LEAD_BULK_IMPORT_MAX_BYTES) {
                    setPreview({ rows: [], errors: ['CSV must be 1 MB or smaller.'] });
                    return;
                  }
                  setPreview(parseLeadBulkImportCsv(await file.text()));
                }}
              />
            </div>
          ) : null}

          {preview && !importId ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{preview.rows.length} rows</Badge>
                <Badge variant={hasValidationErrors ? 'destructive' : 'success'}>
                  {hasValidationErrors
                    ? `${invalidRows.length + preview.errors.length} issues`
                    : 'Ready to import'}
                </Badge>
                <Badge variant="outline">{fileName}</Badge>
              </div>
              {preview.errors.length ? (
                <Alert variant="destructive">
                  <CircleAlert className="size-4" />
                  <AlertTitle>Template validation failed</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {preview.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              {preview.rows.length ? (
                <div className="max-h-80 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Validation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row) => (
                        <TableRow key={row.rowNumber}>
                          <TableCell>{row.rowNumber}</TableCell>
                          <TableCell className="max-w-44 truncate">
                            {row.values.customer_name}
                          </TableCell>
                          <TableCell>{row.values.phone}</TableCell>
                          <TableCell>{row.values.source}</TableCell>
                          <TableCell className="min-w-64">
                            {row.errors.length ? (
                              <span className="text-xs text-destructive">
                                {row.errors.join(' ')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                                <CheckCircle2 className="size-3.5" /> Valid
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {preview.rows.length > previewRows.length ? (
                    <p className="border-t p-2 text-center text-xs text-muted-foreground">
                      Showing the first {previewRows.length} of {preview.rows.length} rows.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {submit.isError ? (
                <Alert variant="destructive">
                  <CircleAlert className="size-4" />
                  <AlertTitle>Import could not be queued</AlertTitle>
                  <AlertDescription>{leadBulkImportErrorMessage(submit.error)}</AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}

          {importId ? (
            <div className="grid gap-4 rounded-lg border p-5">
              <div className="flex items-start gap-3">
                {status.data && !activeStatuses.has(status.data.status) ? (
                  <CheckCircle2 className="mt-0.5 size-6 text-emerald-600" />
                ) : (
                  <Loader2 className="mt-0.5 size-6 animate-spin text-blue-600" />
                )}
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">Background import</p>
                    <Badge variant={status.data?.status === 'FAILED' ? 'destructive' : 'secondary'}>
                      {status.data ? statusLabel(status.data.status) : 'Loading'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    You may close this window. Processing continues safely in the background.
                  </p>
                </div>
              </div>
              {status.data ? (
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-md bg-muted p-3">
                    <p className="text-xl font-semibold">{status.data.total_rows}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                  <div className="rounded-md bg-emerald-50 p-3">
                    <p className="text-xl font-semibold text-emerald-700">
                      {status.data.imported_rows}
                    </p>
                    <p className="text-xs text-emerald-700">Imported</p>
                  </div>
                  <div className="rounded-md bg-red-50 p-3">
                    <p className="text-xl font-semibold text-red-700">
                      {status.data.rejected_rows}
                    </p>
                    <p className="text-xs text-red-700">Rejected</p>
                  </div>
                </div>
              ) : null}
              {status.data?.row_errors.length ? (
                <Alert variant="destructive">
                  <CircleAlert className="size-4" />
                  <AlertTitle>Some rows need attention</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {status.data.row_errors.map((error) => (
                        <li key={`${error.row_number}-${error.code}`}>
                          Row {error.row_number}: {rowErrorLabels[error.code] ?? error.code}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              {status.isError ? (
                <p className="text-sm text-destructive">
                  Import status could not be refreshed. Try again.
                </p>
              ) : null}
              {status.data && !activeStatuses.has(status.data.status) ? (
                <Button
                  type="button"
                  variant="outline"
                  className="justify-self-start"
                  onClick={reset}
                >
                  <FileSpreadsheet className="size-4" /> Import another CSV
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {importId && activeStatuses.has(status.data?.status ?? 'QUEUED') ? 'Close' : 'Cancel'}
          </Button>
          {!importId ? (
            <Button
              type="button"
              disabled={
                !selectedBranchId ||
                !preview ||
                preview.rows.length === 0 ||
                hasValidationErrors ||
                submit.isPending
              }
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {submit.isPending ? 'Queueing…' : `Import ${validRows.length} leads`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
