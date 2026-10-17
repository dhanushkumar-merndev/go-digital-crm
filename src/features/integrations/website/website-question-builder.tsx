'use client';

import { ArrowDown, ArrowUp, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  customQuestionTypes,
  defaultWebsiteQuestions,
  lockedWebsiteFields,
  WEBSITE_LIMITS,
  websiteFieldSpecs,
  websiteQuestion,
  websiteQuestionFields,
  type WebsiteQuestion,
  type WebsiteQuestionField,
  type WebsiteQuestionType,
} from '@/lib/providers/website-lead-adapter';

const customTypeLabels: Partial<Record<WebsiteQuestionType, string>> = {
  text: 'Free text',
  choice: 'Pick one option',
  yes_no: 'Yes / No',
};

function answerHint(question: WebsiteQuestion) {
  switch (question.type) {
    case 'model_picker':
      return 'Buttons for your active vehicle models';
    case 'branch_picker':
      return 'Buttons for the showrooms in this connection — the lead is routed there';
    case 'yes_no':
      return 'Yes / No buttons';
    case 'phone':
      return 'Validated Indian mobile number';
    case 'email':
      return 'Validated email';
    default:
      return null;
  }
}

function OptionsInput({
  question,
  onChange,
}: {
  question: WebsiteQuestion;
  onChange: (options: string[]) => void;
}) {
  const [text, setText] = useState(question.options.join(', '));
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      Answer options (comma separated)
      <Input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            event.target.value
              .split(',')
              .map((option) => option.trim())
              .filter(Boolean),
          );
        }}
        maxLength={800}
        className="h-8 text-sm"
      />
    </label>
  );
}

export function WebsiteQuestionBuilder({
  questions,
  onChange,
}: {
  questions: WebsiteQuestion[];
  onChange: (questions: WebsiteQuestion[]) => void;
}) {
  const usedFields = new Set(questions.map((question) => question.field));
  const addableFields = websiteQuestionFields.filter(
    (field) => field === 'custom' || !usedFields.has(field),
  );

  function update(index: number, patch: Partial<WebsiteQuestion>) {
    onChange(
      questions.map((question, at) => (at === index ? { ...question, ...patch } : question)),
    );
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function add(field: WebsiteQuestionField) {
    let id: string = field;
    if (field === 'custom') {
      let counter = 1;
      while (questions.some((question) => question.id === `custom_${counter}`)) counter += 1;
      id = `custom_${counter}`;
    }
    onChange([...questions, websiteQuestion(field, { id })]);
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Chat questions</p>
          <p className="text-xs text-muted-foreground">
            Asked one at a time, in this order. Name and mobile number are always asked.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(defaultWebsiteQuestions())}
        >
          <RotateCcw className="size-3.5" />
          Reset
        </Button>
      </div>
      <ol className="grid gap-2">
        {questions.map((question, index) => {
          const spec = websiteFieldSpecs[question.field];
          const locked = lockedWebsiteFields.includes(question.field);
          const editableOptions = question.type === 'choice' && !spec.fixedOptions;
          const hint = answerHint(question);
          return (
            <li key={question.id} className="grid gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">{index + 1}.</span>
                <Badge variant="secondary">{spec.label}</Badge>
                {locked ? (
                  <Lock className="size-3.5 text-muted-foreground" aria-label="Always asked" />
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <label className="mr-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    Required
                    <Switch
                      checked={question.required}
                      disabled={locked}
                      onCheckedChange={(required) => update(index, { required })}
                      aria-label={`${spec.label} required`}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label="Move up"
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={index === questions.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label="Move down"
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={locked}
                    onClick={() => onChange(questions.filter((_, at) => at !== index))}
                    aria-label="Remove question"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <Input
                value={question.prompt}
                onChange={(event) => update(index, { prompt: event.target.value })}
                maxLength={200}
                aria-label={`${spec.label} question text`}
                className="h-8 text-sm"
              />
              {question.field === 'custom' ? (
                <Select
                  value={question.type}
                  onValueChange={(type) =>
                    update(index, {
                      type: type as WebsiteQuestionType,
                      options:
                        type === 'choice' && question.options.length < 2
                          ? ['Option 1', 'Option 2']
                          : question.options,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {customQuestionTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {customTypeLabels[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {editableOptions ? (
                <OptionsInput
                  key={`${question.id}:${question.type}`}
                  question={question}
                  onChange={(options) => update(index, { options })}
                />
              ) : question.type === 'choice' ? (
                <p className="text-xs text-muted-foreground">
                  Options: {question.options.join(' · ')}
                </p>
              ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {questions.length < WEBSITE_LIMITS.maxQuestions ? (
        <Select value="" onValueChange={(field) => add(field as WebsiteQuestionField)}>
          <SelectTrigger className="w-fit gap-2">
            <Plus className="size-4" />
            <SelectValue placeholder="Add a question" />
          </SelectTrigger>
          <SelectContent>
            {addableFields.map((field) => (
              <SelectItem key={field} value={field}>
                {websiteFieldSpecs[field].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
