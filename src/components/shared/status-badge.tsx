import { Badge } from '@/components/ui/badge';

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const variant =
    normalized.includes('risk') ||
    normalized.includes('failed') ||
    normalized.includes('overdue') ||
    normalized.includes('attention')
      ? 'destructive'
      : normalized.includes('pending') ||
          normalized.includes('progress') ||
          normalized.includes('required') ||
          normalized.includes('manual')
        ? 'warning'
        : normalized.includes('complete') ||
            normalized.includes('healthy') ||
            normalized.includes('enabled') ||
            normalized.includes('available') ||
            normalized.includes('approved')
          ? 'success'
          : normalized.includes('new') ||
              normalized.includes('active') ||
              normalized.includes('connected')
            ? 'info'
            : 'secondary';
  return <Badge variant={variant}>{value.replaceAll('_', ' ')}</Badge>;
}
