'use client';

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SalesHandoffCandidate } from './lead-workspace-api';

export const AUTO_SALES_HANDOFF = 'auto';

export function SalesConsultantSelector({
  consultants,
  value,
  onValueChange,
  search,
  onSearchChange,
  loading,
  failed,
  disabled = false,
}: {
  consultants: SalesHandoffCandidate[];
  value: string;
  onValueChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  loading: boolean;
  failed: boolean;
  disabled?: boolean;
}) {
  const recommended = consultants.find((consultant) => consultant.recommended);
  const continuity = recommended?.assignment_mode === 'SAME_CUSTOMER';
  const prefersContinuity = consultants[0]?.assignment_mode === 'SAME_CUSTOMER';
  const rotates = consultants[0]?.assignment_mode === 'ROUND_ROBIN';

  return (
    <div className="grid gap-1.5 text-sm font-medium">
      <span>Sales Consultant</span>
      {continuity && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
          <p className="font-medium">Recommended: {recommended.full_name}</p>
          <p className="mt-1 text-xs font-normal text-blue-900/80">
            An earlier enquiry is with this consultant. You can choose another eligible consultant
            for this enquiry.
          </p>
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="pl-9"
          placeholder="Search Sales Consultant"
          maxLength={160}
          disabled={disabled}
        />
      </div>
      <Select value={value} onValueChange={onValueChange} disabled={disabled || loading || failed}>
        <SelectTrigger aria-label="Sales Consultant">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_SALES_HANDOFF}>
            Auto-assign ·{' '}
            {prefersContinuity
              ? 'existing consultant'
              : rotates
                ? 'next in rotation'
                : 'fewest open leads'}
            {recommended ? ` (${recommended.full_name})` : ''}
          </SelectItem>
          {consultants.map((consultant) => (
            <SelectItem key={consultant.user_id} value={consultant.user_id}>
              {consultant.full_name} · {consultant.open_leads} open
              {consultant.hot_leads ? ` · ${consultant.hot_leads} hot` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs font-normal text-muted-foreground">
        {loading
          ? 'Loading the team’s Sales Consultants…'
          : failed
            ? 'The Sales Consultant list is currently unavailable.'
            : consultants.length
              ? 'Choose a consultant, or use the automatic recommendation.'
              : 'No eligible Sales Consultant is available in this team.'}
      </p>
    </div>
  );
}
