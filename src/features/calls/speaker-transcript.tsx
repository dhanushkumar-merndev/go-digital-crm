export type SpeakerTurn = {
  speaker: 'AGENT' | 'CUSTOMER' | 'UNKNOWN';
  text: string;
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
  return /STEREO|CHANNEL/i.test(method)
    ? 'Speaker labels are based on the separated call channels.'
    : 'Speaker labels were inferred by AI and may be imperfect. Unclear means the speaker could not be identified safely.';
}

export function SpeakerTranscript({
  turns,
  fallbackText,
  separationMethod,
  truncated = false,
  compact = false,
}: {
  turns: SpeakerTurn[];
  fallbackText: string | null;
  separationMethod: string | null;
  truncated?: boolean;
  compact?: boolean;
}) {
  const note = turns.length ? separationNote(separationMethod) : null;

  return (
    <div className="space-y-3">
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
                    {turn.text}
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
