'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { spokenLanguageName } from './spoken-language';

export type SpeakerTurn = {
  speaker: 'AGENT' | 'CUSTOMER' | 'UNKNOWN';
  text: string;
  /** The words as spoken, when `text` is the English translation. */
  original_text?: string | null;
};

function speakerPresentation(speaker: SpeakerTurn['speaker']) {
  if (speaker === 'AGENT')
    return {
      label: 'Agent',
      alignment: 'justify-start',
      surface: 'border-blue-200 bg-blue-50/70',
      labelColor: 'text-blue-700',
    };
  if (speaker === 'CUSTOMER')
    return {
      label: 'Customer',
      alignment: 'justify-end',
      surface: 'border-emerald-200 bg-emerald-50/70',
      labelColor: 'text-emerald-700',
    };
  return {
    label: 'Unclear',
    alignment: 'justify-start',
    surface: 'border-amber-200 bg-amber-50/70',
    labelColor: 'text-amber-800',
  };
}

function separationNote(method: string | null) {
  if (!method) return null;
  if (/STEREO|CHANNEL/i.test(method))
    return 'Speaker labels are based on the separated call channels.';
  if (method === 'PROVIDER_DIARIZATION')
    return 'Voices were separated from the recording; AI decided which voice is the agent. Unclear means it could not tell safely.';
  return 'Speaker labels were inferred by AI and may be imperfect. Unclear means the speaker could not be identified safely.';
}

export function SpeakerTranscript({
  turns,
  fallbackText,
  separationMethod,
  language = null,
  truncated = false,
  compact = false,
}: {
  turns: SpeakerTurn[];
  fallbackText: string | null;
  separationMethod: string | null;
  /** The spoken language code (e.g. ta-IN); turns are shown in English by default. */
  language?: string | null;
  truncated?: boolean;
  compact?: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const note = turns.length ? separationNote(separationMethod) : null;
  const translated = turns.some(
    (turn) => turn.original_text && turn.original_text.trim() !== turn.text.trim(),
  );
  const spoken = spokenLanguageName(language);

  return (
    <div className="space-y-3">
      {translated && !compact && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {showOriginal ? `Spoken in ${spoken}` : `Translated to English from ${spoken}`}
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setShowOriginal((value) => !value)}
          >
            {showOriginal ? 'Show English' : `Show original (${spoken})`}
          </Button>
        </div>
      )}
      {turns.length ? (
        <div className="space-y-2">
          {turns.map((turn, index) => {
            const presentation = speakerPresentation(turn.speaker);
            return (
              <div key={`${index}-${turn.speaker}`} className={`flex ${presentation.alignment}`}>
                <div
                  className={`${compact ? 'max-w-full' : 'max-w-[88%]'} rounded-lg border px-3 py-2 ${presentation.surface}`}
                >
                  <p
                    className={`text-[11px] font-semibold uppercase tracking-wide ${presentation.labelColor}`}
                  >
                    {presentation.label}
                  </p>
                  <p
                    className={`${compact ? 'line-clamp-3 text-xs leading-5' : 'text-sm leading-6'} mt-1 whitespace-pre-wrap text-slate-700`}
                  >
                    {showOriginal && turn.original_text ? turn.original_text : turn.text}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          {fallbackText ?? 'Transcript processing has not produced text yet.'}
        </p>
      )}
      {note && <p className="text-xs leading-5 text-muted-foreground">{note}</p>}
      {truncated && (
        <p className="text-xs font-medium text-amber-700">
          This transcript view is truncated to protect response size.
        </p>
      )}
    </div>
  );
}
