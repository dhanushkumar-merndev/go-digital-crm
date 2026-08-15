import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function ProductionDataUnavailable() {
  return (
    <Card className="mx-auto max-w-xl shadow-none">
      <CardContent className="flex flex-col items-center p-10 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-amber-50 text-amber-700">
          <ShieldAlert className="size-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold">Live workspace unavailable</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          Sample records are disabled in this environment. This module remains closed until its
          authorized Supabase data adapter is connected.
        </p>
        <p className="mt-4 text-xs text-muted-foreground">Reference: GDM-DATA-BOUNDARY</p>
      </CardContent>
    </Card>
  );
}
