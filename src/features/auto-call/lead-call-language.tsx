'use client';

import { useMutation } from '@tanstack/react-query';
import { Languages } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { aiCallLanguages } from './ai-call-script-definition';
import { autoCallErrorMessage, setLeadCallLanguage } from './auto-call-api';

const SCRIPT_DEFAULT = 'default';

/** The language the AI agent speaks when it auto-calls this lead. */
export function LeadCallLanguage({
  leadId,
  value,
  canEdit,
  onSaved,
}: {
  leadId: string;
  value: string | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const save = useMutation({
    meta: { toast: false },
    mutationFn: (language: string | null) => setLeadCallLanguage(leadId, language),
    onSuccess: () => {
      onSaved();
      toast.add({ type: 'success', title: 'Call language saved' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Call language was not saved',
        description: autoCallErrorMessage(error, 'Try again.'),
      }),
  });
  return (
    <div className="border-t pt-3">
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Languages className="size-3" /> AI call language
      </p>
      <Select
        value={value ?? SCRIPT_DEFAULT}
        disabled={!canEdit || save.isPending}
        onValueChange={(next) => save.mutate(next === SCRIPT_DEFAULT ? null : next)}
      >
        <SelectTrigger className="mt-1 h-8 w-full text-sm" aria-label="AI call language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SCRIPT_DEFAULT}>Script default</SelectItem>
          {aiCallLanguages.map((language) => (
            <SelectItem key={language.value} value={language.value}>
              {language.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
