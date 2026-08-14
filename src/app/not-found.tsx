import Link from 'next/link';
import { CircleX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
            <CircleX />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Page not available</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This route is not part of the selected role preset or your access scope.
            </p>
          </div>
          <Button asChild>
            <Link href="/telecaller/dashboard">Return to CRM</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
