import Link from 'next/link';
import {
  ArrowLeft,
  CalendarClock,
  CarFront,
  FileText,
  MessageSquareText,
  Phone,
  UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const timeline = [
  {
    title: 'Follow-up scheduled',
    detail: 'Price discussion · Tomorrow, 11:30 AM',
    time: '12 min ago',
    icon: CalendarClock,
  },
  {
    title: 'Call connected',
    detail: 'Outbound call · 04:18 · Recording available',
    time: '1 hr ago',
    icon: Phone,
  },
  {
    title: 'Lead qualified',
    detail: 'Budget and purchase timeline confirmed',
    time: 'Yesterday',
    icon: UserRound,
  },
  {
    title: 'Customer matched',
    detail: 'Possible match reviewed and linked by Priya Nair',
    time: '12 Aug',
    icon: MessageSquareText,
  },
];

export function RecordWorkspace({ role, id }: { role: string; id: string }) {
  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-3">
          <Link href={`/${role}/dashboard`}>
            <ArrowLeft className="size-4" />
            Back to workspace
          </Link>
        </Button>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">Aarav Sharma</h1>
              <Badge variant="info">Qualified</Badge>
              <Badge variant="warning">PENDING</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Customer GDM-C-10842 · Lead {id.toUpperCase()}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline">
              <Phone className="size-4" />
              Call
            </Button>
            <Button>Schedule follow-up</Button>
          </div>
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.45fr_.8fr]">
        <div className="space-y-6">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Customer information</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Phone', '+91 98731 00001'],
                ['Email', 'aarav.sharma@example.in'],
                ['Location', 'Indiranagar, Bengaluru'],
                ['Preferred branch', 'MG Road'],
                ['Source', 'Google Ads'],
                ['Owner', 'Priya Nair'],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1.5 text-sm font-semibold">{value}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CarFront className="size-4 text-blue-600" />
                Vehicle requirement
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Model', 'Nexon EV'],
                ['Variant', 'Empowered+ LR'],
                ['Colour', 'Pristine White'],
                ['Budget', '₹16–19 L'],
                ['Purchase timeline', 'Within 30 days'],
                ['Finance', 'Required'],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1.5 text-sm font-semibold">{value}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="size-4 text-blue-600" />
                Lead information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-5 sm:grid-cols-3">
                {[
                  ['Lifecycle', 'Qualified'],
                  ['Temperature', 'Hot'],
                  ['Next follow-up', '15 Aug, 11:30 AM'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-1.5 text-sm font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border bg-muted/30 p-4">
                <p className="text-sm font-semibold">Customer requirements</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Interested in the long-range variant, needs home charger information and would
                  like an exchange evaluation for a 2018 hatchback.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Activity timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {timeline.map((item, index) => (
                <div className="relative flex gap-3 pb-6" key={item.title}>
                  {index < timeline.length - 1 && (
                    <span className="absolute left-4 top-8 h-full w-px bg-border" />
                  )}
                  <div className="z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-white text-blue-600">
                    <item.icon className="size-4" />
                  </div>
                  <div className="pt-0.5">
                    <p className="text-sm font-semibold">{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{item.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
