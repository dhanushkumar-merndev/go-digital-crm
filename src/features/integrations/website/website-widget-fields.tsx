'use client';

import { MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { WebsiteWidgetConfig } from '@/lib/providers/website-lead-adapter';
import { WebsiteQuestionBuilder } from './website-question-builder';

/**
 * Settings for one website connection: where the chat may run, how it looks,
 * what it asks, and which team receives the leads. Validation runs once on
 * save through parseWebsiteWidgetConfig, the same parser the Edge Function uses.
 */
export function WebsiteWidgetFields({
  value,
  onChange,
  teams,
  defaultTeamId,
  onDefaultTeamIdChange,
}: {
  value: WebsiteWidgetConfig;
  onChange: (value: WebsiteWidgetConfig) => void;
  teams: Array<{ id: string; name: string }>;
  defaultTeamId: string;
  onDefaultTeamIdChange: (value: string) => void;
}) {
  const [originsText, setOriginsText] = useState(value.allowed_origins.join('\n'));
  const set = <K extends keyof WebsiteWidgetConfig>(key: K, next: WebsiteWidgetConfig[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="grid gap-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <MessageSquareText className="size-4" />
          <span>Website chat widget & Lead API</span>
        </div>
        <p className="text-xs text-muted-foreground">
          The chat asks your questions on the dealership website and creates a Website lead for the
          telecaller team. The Lead API lets your website backend or tools such as Zapier send leads
          with a secret key. API keys are created after saving, from the connection details.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm font-medium">
          Chat widget on website
          <Switch
            checked={value.widget_enabled}
            onCheckedChange={(checked) => set('widget_enabled', checked)}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm font-medium">
          Lead API (secret key)
          <Switch
            checked={value.api_enabled}
            onCheckedChange={(checked) => set('api_enabled', checked)}
          />
        </label>
      </div>

      <label className="grid gap-1.5 text-sm font-medium">
        Lead routing team
        <Select value={defaultTeamId} onValueChange={onDefaultTeamIdChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">The chosen showroom&apos;s first active team</SelectItem>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs font-normal text-muted-foreground">
          Leads are assigned to this team&apos;s telecallers using its assignment mode. When a
          visitor picks a different showroom, that showroom&apos;s team receives the lead.
        </span>
      </label>

      {value.widget_enabled ? (
        <>
          <label className="grid gap-1.5 text-sm font-medium">
            Website domains allowed to show the chat
            <Textarea
              value={originsText}
              onChange={(event) => {
                setOriginsText(event.target.value);
                set(
                  'allowed_origins',
                  event.target.value
                    .split(/[\n,]/)
                    .map((origin) => origin.trim())
                    .filter(Boolean),
                );
              }}
              rows={3}
              placeholder={'https://www.yourdealership.com\nhttps://yourdealership.com'}
              className="font-mono text-xs"
            />
            <span className="text-xs font-normal text-muted-foreground">
              One per line. Browsers refuse to show the chat on any other site, and submissions from
              other sites are rejected. Add both the www and non-www address if your site uses both.
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="grid gap-1.5 text-sm font-medium">
              Chat title
              <Input
                value={value.title}
                maxLength={60}
                onChange={(event) => set('title', event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Colour
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(value.accent_color) ? value.accent_color : '#2563eb'
                  }
                  onChange={(event) => set('accent_color', event.target.value)}
                  className="h-9 w-10 cursor-pointer rounded-md border bg-background p-1"
                  aria-label="Accent colour"
                />
                <Input
                  value={value.accent_color}
                  maxLength={7}
                  onChange={(event) => set('accent_color', event.target.value)}
                  className="w-24 font-mono text-xs"
                  aria-label="Accent colour hex"
                />
              </div>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Greeting
            <Textarea
              value={value.greeting}
              maxLength={240}
              rows={2}
              onChange={(event) => set('greeting', event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Thank-you message
            <Input
              value={value.success_message}
              maxLength={240}
              onChange={(event) => set('success_message', event.target.value)}
            />
          </label>
          <WebsiteQuestionBuilder
            questions={value.questions}
            onChange={(questions) => set('questions', questions)}
          />
        </>
      ) : null}
    </div>
  );
}
