'use client';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, GitCompareArrows, Lightbulb, Scale, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { PageSpec } from '@/lib/domain';
import { fetchCompetitorComparisonOptions } from './competitor-comparison-api';
function display(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not specified';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function label(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function CompetitorComparisonWorkspace({ spec }: { spec: PageSpec }) {
  const query = useQuery({
    queryKey: ['sales-competitor-comparison'],
    queryFn: ({ signal }) => fetchCompetitorComparisonOptions(signal),
    staleTime: 60_000,
  });
  const [ourId, setOurId] = useState('');
  const [competitorId, setCompetitorId] = useState('');
  useEffect(() => {
    if (!ourId && query.data?.our_variants[0]) setOurId(query.data.our_variants[0].id);
    if (!competitorId && query.data?.competitors[0]) setCompetitorId(query.data.competitors[0].id);
  }, [query.data, ourId, competitorId]);
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <CircleAlert className="mx-auto size-7 text-destructive" />
          <p className="mt-3 font-semibold">Competitor comparison is unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your Sales Consultant access and deployed competitor catalog.
          </p>
        </CardContent>
      </Card>
    );
  const ours = query.data.our_variants.find((row) => row.id === ourId);
  const competitor = query.data.competitors.find((row) => row.id === competitorId);
  const specs = useMemo(
    () =>
      Array.from(
        new Set([
          ...Object.keys(ours?.specifications ?? {}),
          ...Object.keys(competitor?.specifications ?? {}),
          ...(competitor?.ex_showroom_price !== null ? ['ex_showroom_price'] : []),
        ]),
      ).sort(),
    [ours, competitor],
  );
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">
          Sales workspace › Competitor compare
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Compare verified vehicle specifications and position the dealership&apos;s vehicle
          accurately.
        </p>
      </div>
      <Card className="shadow-none">
        <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto_1fr]">
          <div className="space-y-2">
            <p className="text-sm font-medium">Our vehicle</p>
            <Select value={ourId} onValueChange={setOurId}>
              <SelectTrigger>
                <SelectValue placeholder="Select dealership variant" />
              </SelectTrigger>
              <SelectContent>
                {query.data.our_variants.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.brand} {row.model} · {row.variant}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-center">
            <span className="rounded-full bg-blue-50 p-3 text-sm font-semibold text-primary">
              VS
            </span>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Competitor vehicle</p>
            <Select value={competitorId} onValueChange={setCompetitorId}>
              <SelectTrigger>
                <SelectValue placeholder="Select verified competitor profile" />
              </SelectTrigger>
              <SelectContent>
                {query.data.competitors.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.manufacturer} {row.model} · {row.variant}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
      {ours && competitor ? (
        <>
          <Card className="overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GitCompareArrows className="size-4 text-primary" /> Specification comparison
              </CardTitle>
              <CardDescription>
                Only fields configured in the dealership variant and competitor catalog are shown.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Specification</TableHead>
                    <TableHead>
                      {ours.brand} {ours.model} · <Badge variant="success">Our vehicle</Badge>
                    </TableHead>
                    <TableHead>
                      {competitor.manufacturer} {competitor.model} ·{' '}
                      <Badge variant="secondary">Competitor</Badge>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {specs.map((key) => (
                    <TableRow key={key}>
                      <TableCell className="font-medium">{label(key)}</TableCell>
                      <TableCell>{display(ours.specifications[key])}</TableCell>
                      <TableCell>
                        {key === 'ex_showroom_price'
                          ? competitor.ex_showroom_price === null
                            ? 'Not specified'
                            : new Intl.NumberFormat('en-IN', {
                                style: 'currency',
                                currency: 'INR',
                                maximumFractionDigits: 0,
                              }).format(competitor.ex_showroom_price)
                          : display(competitor.specifications[key])}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!specs.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        Add verified specifications in the vehicle and competitor catalogs to
                        compare them here.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-emerald-700">
                  <Check className="size-4" /> Competitor profile advantages
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {competitor.advantages.map((item) => (
                    <li key={item} className="flex gap-2">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                      {item}
                    </li>
                  ))}
                  {!competitor.advantages.length ? (
                    <li>No verified advantage statements are configured.</li>
                  ) : null}
                </ul>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Scale className="size-4 text-primary" /> Recommended sales approach
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Ask the customer which specification matters most, then use only the verified
                differences above. Do not make unsupported claims about either vehicle.
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lightbulb className="size-4 text-amber-600" /> Catalog quality
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Keep competitor profiles current through Client Admin. This page does not generate
                AI claims or infer specifications from customer notes.
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <Card className="shadow-none">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Configure at least one active dealership variant and one active competitor profile to
            start comparison.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
