'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { fetchSocialContentCalendar } from './social-content-calendar-api';

function dateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function addDays(value: string, count: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return dateKey(date);
}

function label(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(`${value}T00:00:00Z`));
}

export function SocialContentCalendar() {
  const [startDate, setStartDate] = useState(() => dateKey(new Date()));
  const [days, setDays] = useState<7 | 14 | 31>(7);
  const query = useQuery({
    queryKey: ['social-content-calendar', startDate, days],
    queryFn: ({ signal }) => fetchSocialContentCalendar({ startDate, days, signal }),
    staleTime: 60_000,
  });
  const dates = useMemo(
    () => Array.from({ length: days }, (_, index) => addDays(startDate, index)),
    [days, startDate],
  );
  const postsByDay = useMemo(() => {
    const result = new Map<string, NonNullable<typeof query.data>['posts']>();
    for (const post of query.data?.posts ?? []) {
      if (!post.scheduled_for) continue;
      const key = dateKey(new Date(post.scheduled_for));
      result.set(key, [...(result.get(key) ?? []), post]);
    }
    return result;
  }, [query.data?.posts]);
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="size-4 text-blue-600" /> Content calendar
          </CardTitle>
          <CardDescription>
            Scheduled or published posts in your authorized branch scope.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => setStartDate((value) => addDays(value, -days))}
          >
            <ChevronLeft className="size-4" />
            <span className="sr-only">Previous period</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setStartDate(dateKey(new Date()))}>
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => setStartDate((value) => addDays(value, days))}
          >
            <ChevronRight className="size-4" />
            <span className="sr-only">Next period</span>
          </Button>
          <Select
            value={String(days)}
            onValueChange={(value) => setDays(Number(value) as 7 | 14 | 31)}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 days</SelectItem>
              <SelectItem value="14">14 days</SelectItem>
              <SelectItem value="31">31 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <div className="grid min-w-[840px] grid-cols-7 border-t">
          {dates.map((day) => (
            <div key={day} className="min-h-44 border-b border-r p-2 last:border-r-0">
              <p className="mb-2 text-xs font-semibold text-[#17233d]">{label(day)}</p>
              <div className="space-y-1.5">
                {(postsByDay.get(day) ?? []).map((post) => (
                  <div key={post.id} className="rounded-md border bg-muted/30 p-2">
                    <div className="flex items-center justify-between gap-1">
                      <Badge
                        variant={post.status === 'PUBLISHED' ? 'success' : 'secondary'}
                        className="text-[10px]"
                      >
                        {post.platform}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {post.scheduled_for
                          ? new Intl.DateTimeFormat('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'Asia/Kolkata',
                            }).format(new Date(post.scheduled_for))
                          : ''}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-[#263550]">
                      {post.content}
                    </p>
                  </div>
                ))}
                {query.isSuccess && !(postsByDay.get(day) ?? []).length ? (
                  <p className="py-3 text-center text-[10px] text-muted-foreground">
                    No scheduled posts
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {query.isError ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Content calendar could not be loaded for the current marketing scope.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
