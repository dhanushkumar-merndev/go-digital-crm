'use client';

import { Building2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = 'all';

/**
 * Which of the caller's branches a page shows. The server returns only branches
 * the caller can open and re-checks the choice, so this filters within scope and
 * never widens it. With one branch there is nothing to pick. Pages that can sum
 * every branch pass `allLabel`; choosing it reports `null`.
 */
export function BranchPicker({
  branches,
  value,
  onChange,
  allLabel,
}: {
  branches: Array<{ id: string; name: string }>;
  value: string | null;
  onChange: (branchId: string | null) => void;
  allLabel?: string;
}) {
  if (branches.length < 2) return null;
  return (
    <Select
      value={value ?? (allLabel ? ALL : undefined)}
      onValueChange={(next) => onChange(next === ALL ? null : next)}
    >
      <SelectTrigger className="h-9 w-52 bg-background text-xs" aria-label="Branch">
        <Building2 className="size-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allLabel ? <SelectItem value={ALL}>{allLabel}</SelectItem> : null}
        {branches.map((branch) => (
          <SelectItem key={branch.id} value={branch.id}>
            {branch.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
