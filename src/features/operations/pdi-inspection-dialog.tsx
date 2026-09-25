'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  CheckCircle2,
  ClipboardCheck,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
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
import { toast } from '@/components/ui/toast';
import {
  fetchOrCreatePdiInspection,
  savePdiInspection,
  type PdiItemCategory,
  type PdiItemStatus,
} from './pdi-inspection-api';

interface PdiInspectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deliveryId: string;
  bookingNumber?: string;
  customerName?: string;
  onInspectionCompleted?: () => void;
}

const categoryLabels: Record<PdiItemCategory, string> = {
  EXTERIOR: 'Exterior & Body',
  INTERIOR: 'Interior & Cabin',
  MECHANICAL: 'Engine & Fluids',
  ELECTRICAL: 'Electrical & Electronics',
  WHEELS_TYRES: 'Tyres & Tooling',
};

export function PdiInspectionDialog({
  open,
  onOpenChange,
  deliveryId,
  bookingNumber,
  customerName,
  onInspectionCompleted,
}: PdiInspectionDialogProps) {
  const queryClient = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<PdiItemCategory | 'ALL'>('ALL');
  const [overallNotes, setOverallNotes] = useState('');
  const [editingDefectId, setEditingDefectId] = useState<string | null>(null);
  const [defectText, setDefectText] = useState('');

  const pdiQuery = useQuery({
    queryKey: ['pdi-inspection', deliveryId],
    queryFn: () => fetchOrCreatePdiInspection(deliveryId),
    enabled: open,
    staleTime: 5_000,
  });

  // Results are a local draft keyed by item id. Clicking Pass, Defect or
  // Rectified updates the sheet instantly; the draft reaches the server in one
  // request, either as "Save progress" or together with the certification.
  const [draft, setDraft] = useState<
    Record<string, { status: PdiItemStatus; notes: string | null }>
  >({});
  const setItemResult = (itemId: string, status: PdiItemStatus, notes: string | null = null) => {
    setDraft((current) => ({ ...current, [itemId]: { status, notes } }));
    setEditingDefectId(null);
    setDefectText('');
  };

  const saveMutation = useMutation({
    mutationFn: (complete: boolean) =>
      savePdiInspection({
        inspectionId: pdiQuery.data!.inspection.id,
        items: Object.entries(draft).map(([id, result]) => ({ id, ...result })),
        notes: overallNotes,
        complete,
      }),
    onSuccess: async (_result, complete) => {
      await queryClient.invalidateQueries({ queryKey: ['pdi-inspection', deliveryId] });
      setDraft({});
      if (!complete) {
        toast.add({ type: 'success', title: 'PDI progress saved' });
        return;
      }
      toast.add({
        type: 'success',
        title: 'PDI Inspection Approved',
        description:
          'Vehicle has passed 100% Pre-Delivery Inspection and is certified for delivery.',
      });
      queryClient.invalidateQueries({ queryKey: ['operational-case'] });
      onInspectionCompleted?.();
      onOpenChange(false);
    },
    onError: (err: unknown, complete) => {
      toast.add({
        type: 'error',
        title: complete ? 'Could not complete inspection' : 'Could not save PDI progress',
        description:
          err instanceof Error ? err.message : 'Ensure all items are passed and defects resolved.',
      });
    },
  });

  const items = (pdiQuery.data?.items ?? []).map((item) => {
    const result = draft[item.id];
    return result ? { ...item, status: result.status, defect_notes: result.notes } : item;
  });
  const filteredItems =
    selectedCategory === 'ALL' ? items : items.filter((item) => item.category === selectedCategory);

  const inspection = pdiQuery.data?.inspection;
  const stats = pdiQuery.data
    ? {
        total_items: items.length,
        passed: items.filter((item) => item.status === 'PASSED' || item.status === 'RECTIFIED')
          .length,
        failed: items.filter((item) => item.status === 'FAILED').length,
        pending: items.filter((item) => item.status === 'PENDING').length,
      }
    : undefined;
  const unsavedChanges = Object.keys(draft).length;

  const canSignComplete =
    stats && stats.pending === 0 && stats.failed === 0 && inspection?.status !== 'PASSED';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
                <ClipboardCheck className="size-5 text-primary" />
                Pre-Delivery Inspection (PDI)
              </DialogTitle>
              <DialogDescription className="text-xs">
                {customerName ? `Customer: ${customerName}` : 'Vehicle delivery inspection'}
                {bookingNumber && ` • Booking: ${bookingNumber}`}
              </DialogDescription>
            </div>
            {inspection && (
              <Badge
                variant={
                  inspection.status === 'PASSED'
                    ? 'default'
                    : inspection.status === 'DEFECTS_FOUND'
                      ? 'destructive'
                      : 'secondary'
                }
                className="text-xs font-semibold uppercase tracking-wider"
              >
                {inspection.status.replace('_', ' ')}
              </Badge>
            )}
          </div>

          {stats && (
            <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg bg-muted/40 p-2.5 text-center text-xs">
              <div>
                <span className="text-muted-foreground">Total Points</span>
                <p className="text-base font-bold text-foreground">{stats.total_items}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Passed</span>
                <p className="text-base font-bold text-emerald-600">{stats.passed}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Defects Found</span>
                <p
                  className={`text-base font-bold ${stats.failed > 0 ? 'text-rose-600' : 'text-foreground'}`}
                >
                  {stats.failed}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Pending</span>
                <p
                  className={`text-base font-bold ${stats.pending > 0 ? 'text-amber-600' : 'text-emerald-600'}`}
                >
                  {stats.pending}
                </p>
              </div>
            </div>
          )}

          {/* Category Tabs */}
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1 text-xs">
            <Button
              size="sm"
              variant={selectedCategory === 'ALL' ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setSelectedCategory('ALL')}
            >
              All Points ({pdiQuery.data?.items.length ?? 0})
            </Button>
            {(Object.keys(categoryLabels) as PdiItemCategory[]).map((cat) => (
              <Button
                key={cat}
                size="sm"
                variant={selectedCategory === cat ? 'default' : 'outline'}
                className="h-7 whitespace-nowrap text-xs"
                onClick={() => setSelectedCategory(cat)}
              >
                {categoryLabels[cat]}
              </Button>
            ))}
          </div>
        </DialogHeader>

        {/* Checklist Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {pdiQuery.isLoading ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              Loading PDI checklist points...
            </div>
          ) : (
            filteredItems.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg border p-3 transition-colors ${
                  item.status === 'FAILED'
                    ? 'border-rose-200 bg-rose-50/40'
                    : item.status === 'PASSED' || item.status === 'RECTIFIED'
                      ? 'border-emerald-200/60 bg-emerald-50/20'
                      : 'border-border'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground uppercase">
                        {categoryLabels[item.category]}
                      </span>
                      {item.status === 'RECTIFIED' && (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 text-amber-700 text-[10px] h-4"
                        >
                          Rectified
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium leading-snug">{item.item_name}</p>
                    {item.defect_notes && (
                      <p className="text-xs text-rose-700 font-medium">
                        Defect: {item.defect_notes}
                      </p>
                    )}
                  </div>

                  {/* Status Action Buttons */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant={item.status === 'PASSED' ? 'default' : 'outline'}
                      className={`h-7 px-2.5 text-xs ${
                        item.status === 'PASSED' ? 'bg-emerald-600 hover:bg-emerald-700' : ''
                      }`}
                      onClick={() => setItemResult(item.id, 'PASSED')}
                    >
                      <CheckCircle2 className="size-3.5 mr-1" /> Pass
                    </Button>
                    <Button
                      size="sm"
                      variant={item.status === 'FAILED' ? 'destructive' : 'outline'}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setEditingDefectId(item.id);
                        setDefectText(item.defect_notes || '');
                      }}
                    >
                      <XCircle className="size-3.5 mr-1" /> Defect
                    </Button>
                    {item.status === 'FAILED' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-xs bg-amber-100 hover:bg-amber-200 text-amber-800"
                        onClick={() => setItemResult(item.id, 'RECTIFIED', item.defect_notes)}
                      >
                        <Wrench className="size-3 mr-1" /> Rectified
                      </Button>
                    )}
                  </div>
                </div>

                {/* Defect note inline input */}
                {editingDefectId === item.id && (
                  <div className="mt-3 border-t pt-2.5 space-y-2">
                    <p className="text-xs font-semibold text-rose-700">
                      Record Defect Description:
                    </p>
                    <Input
                      placeholder="Describe scratch, dent, loose wire, alignment gap, etc."
                      value={defectText}
                      onChange={(e) => setDefectText(e.target.value)}
                      className="text-xs"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        onClick={() => setEditingDefectId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-6 text-xs"
                        disabled={!defectText.trim()}
                        onClick={() => setItemResult(item.id, 'FAILED', defectText.trim())}
                      >
                        Save Defect
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer with Sign-off */}
        <DialogFooter className="border-t bg-muted/20 px-6 py-3 flex items-center justify-between sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {inspection?.status === 'PASSED' ? (
              <span className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                <CheckCircle className="size-4" /> Certified and passed for delivery
              </span>
            ) : stats?.failed && stats.failed > 0 ? (
              <span className="flex items-center gap-1.5 text-rose-600 font-semibold">
                <ShieldAlert className="size-4" /> {stats.failed} defect(s) must be resolved or
                rectified
              </span>
            ) : stats?.pending && stats.pending > 0 ? (
              <span>{stats.pending} inspection points remaining</span>
            ) : (
              <span className="text-emerald-700 font-medium">All points verified</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {canSignComplete && (
              <Input
                placeholder="Overall PDI notes (optional)..."
                value={overallNotes}
                onChange={(e) => setOverallNotes(e.target.value)}
                className="h-8 max-w-[200px] text-xs"
              />
            )}
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {inspection?.status !== 'PASSED' && unsavedChanges > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate(false)}
              >
                {saveMutation.isPending && !saveMutation.variables
                  ? 'Saving...'
                  : `Save progress (${unsavedChanges})`}
              </Button>
            )}
            {inspection?.status !== 'PASSED' && (
              <Button
                size="sm"
                disabled={!canSignComplete || saveMutation.isPending}
                onClick={() => saveMutation.mutate(true)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
              >
                {saveMutation.isPending && saveMutation.variables
                  ? 'Signing...'
                  : 'Sign & Certify PDI'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
