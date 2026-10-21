'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  aiCallFields,
  aiCallLanguages,
  aiCallScriptSchema,
  aiCallVoices,
  newQuestionId,
  starterAiCallScript,
  type AiCallLanguage,
  type AiCallScript,
} from './ai-call-script-definition';
import {
  autoCallAdminKey,
  autoCallErrorMessage,
  saveAutoCallAiSettings,
  type AutoCallAdminWorkspace,
  type AutoCallMode,
} from './auto-call-api';

const NO_FIELD = 'none';

/** Starts from the saved script when it is valid, else from the sample. */
function initialScript(saved: AutoCallAdminWorkspace['settings']['ai_script']): AiCallScript {
  const parsed = aiCallScriptSchema.safeParse(saved);
  return parsed.success ? parsed.data : starterAiCallScript();
}

export function AiCallScriptDialog({
  settings,
  mode,
  onClose,
}: {
  settings: AutoCallAdminWorkspace['settings'];
  /** Saved together with the script, so picking AI agent and writing the script is one step. */
  mode: AutoCallMode;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [script, setScript] = useState<AiCallScript>(() => initialScript(settings.ai_script));
  const [problem, setProblem] = useState<string | null>(null);
  const update = (patch: Partial<AiCallScript>) =>
    setScript((current) => ({ ...current, ...patch }));
  const updateQuestion = (index: number, patch: Partial<AiCallScript['questions'][number]>) =>
    update({
      questions: script.questions.map((question, position) =>
        position === index ? { ...question, ...patch } : question,
      ),
    });
  const moveQuestion = (index: number, offset: -1 | 1) => {
    const questions = [...script.questions];
    const [moved] = questions.splice(index, 1);
    questions.splice(index + offset, 0, moved);
    update({ questions });
  };
  const toggleLanguage = (language: AiCallLanguage) => {
    const languages = script.languages.includes(language)
      ? script.languages.filter((entry) => entry !== language)
      : aiCallLanguages
          .map((entry) => entry.value)
          .filter((entry) => entry === language || script.languages.includes(entry));
    update({
      languages,
      default_language: languages.includes(script.default_language)
        ? script.default_language
        : (languages[0] ?? script.default_language),
    });
  };

  const save = useMutation({
    meta: { toast: false },
    mutationFn: (value: AiCallScript) =>
      saveAutoCallAiSettings({
        mode,
        script: value,
        creditCost: settings.ai_credit_cost,
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoCallAdminKey });
      toast.add({ type: 'success', title: 'AI call script saved' });
      onClose();
    },
    onError: (error) =>
      setProblem(autoCallErrorMessage(error, 'The script was not saved. Try again.')),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>AI call script</DialogTitle>
          <DialogDescription>
            What the AI agent says and asks. It introduces itself as an automated assistant, speaks
            the lead&apos;s language and turns answers into suggestions the telecaller reviews.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = aiCallScriptSchema.safeParse(script);
            if (!parsed.success) {
              setProblem(parsed.error.issues[0]?.message ?? 'Check the script.');
              return;
            }
            setProblem(null);
            save.mutate(parsed.data);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ai-agent-name">Agent name</Label>
              <Input
                id="ai-agent-name"
                value={script.agent_name}
                maxLength={40}
                onChange={(event) => update({ agent_name: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Voice</Label>
              <Select
                value={script.voice ?? 'anushka'}
                onValueChange={(voice) => update({ voice })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {aiCallVoices.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ai-intro">Opening line after the greeting (optional)</Label>
            <Input
              id="ai-intro"
              value={script.intro ?? ''}
              maxLength={400}
              placeholder="You recently enquired about a car with us."
              onChange={(event) => update({ intro: event.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ai-goal">Goal of the call</Label>
            <Textarea
              id="ai-goal"
              value={script.goal}
              maxLength={800}
              rows={3}
              onChange={(event) => update({ goal: event.target.value })}
            />
          </div>

          <Separator />
          <div className="grid gap-2">
            <Label>Languages the AI may speak</Label>
            <div className="flex flex-wrap gap-2">
              {aiCallLanguages.map((language) => (
                <Button
                  key={language.value}
                  type="button"
                  size="sm"
                  variant={script.languages.includes(language.value) ? 'default' : 'outline'}
                  aria-pressed={script.languages.includes(language.value)}
                  onClick={() => toggleLanguage(language.value)}
                >
                  {language.label}
                </Button>
              ))}
            </div>
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label>Default language</Label>
              <Select
                value={script.default_language}
                onValueChange={(value) => update({ default_language: value as AiCallLanguage })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {aiCallLanguages
                    .filter((language) => script.languages.includes(language.value))
                    .map((language) => (
                      <SelectItem key={language.value} value={language.value}>
                        {language.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              A lead with its own call language set is called in that language when it is listed
              here. The customer can also ask to switch during the call.
            </p>
          </div>

          <Separator />
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Questions</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={script.questions.length >= 12}
                onClick={() =>
                  update({
                    questions: [
                      ...script.questions,
                      { id: newQuestionId(script.questions), ask: '', field: null },
                    ],
                  })
                }
              >
                <Plus className="size-4" /> Add question
              </Button>
            </div>
            {script.questions.map((question, index) => (
              <div
                key={question.id}
                className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_12rem_auto]"
              >
                <Input
                  aria-label={`Question ${index + 1}`}
                  value={question.ask}
                  maxLength={300}
                  placeholder="Which model are you interested in?"
                  onChange={(event) => updateQuestion(index, { ask: event.target.value })}
                />
                <Select
                  value={question.field ?? NO_FIELD}
                  onValueChange={(value) =>
                    updateQuestion(index, {
                      field:
                        value === NO_FIELD
                          ? null
                          : (value as AiCallScript['questions'][number]['field']),
                    })
                  }
                >
                  <SelectTrigger aria-label={`CRM field for question ${index + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FIELD}>Summary only</SelectItem>
                    {aiCallFields.map((field) => (
                      <SelectItem key={field.value} value={field.value}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => moveQuestion(index, -1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={index === script.questions.length - 1}
                    onClick={() => moveQuestion(index, 1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Remove question"
                    disabled={script.questions.length === 1}
                    onClick={() =>
                      update({
                        questions: script.questions.filter((_, position) => position !== index),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              The AI asks these in a natural order, in the call&apos;s language. An answer linked to
              a CRM field becomes a suggestion; it never changes the lead on its own.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ai-closing">Closing line (optional)</Label>
            <Input
              id="ai-closing"
              value={script.closing ?? ''}
              maxLength={400}
              placeholder="Thank you. Our executive will get in touch with you soon."
              onChange={(event) => update({ closing: event.target.value })}
            />
          </div>

          {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save script'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
