'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileAudio, Plus, Trash2, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  autoCallAdminKey,
  autoCallErrorMessage,
  autoIvrFlowKey,
  createAudioPreviewUrl,
  type AutoIvrFlowRecord,
  fetchAutoIvrFlow,
  publishAutoIvrFlow,
  saveAutoIvrFlowDraft,
  uploadAutoIvrPromptAudio,
} from './auto-call-api';
import { autoIvrLanguages } from './auto-call-settings';
import {
  autoIvrFields,
  blankQuestion,
  defaultSetValue,
  END_NODE,
  ivrKeys,
  newNodeId,
  removeQuestion,
  type AutoIvrDefinition,
  type AutoIvrNode,
  type AutoIvrOption,
  type AutoIvrPrompt,
  type AutoIvrSet,
} from './auto-ivr-definition';

const DEFAULT_LANGUAGE = 'connection-default';

function PromptEditor({
  label,
  prompt,
  organizationId,
  flowId,
  onChange,
}: {
  label: string;
  prompt: AutoIvrPrompt;
  organizationId: string;
  flowId: string;
  onChange: (prompt: AutoIvrPrompt) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const upload = useMutation({
    meta: { toast: false },
    mutationFn: (file: File) => uploadAutoIvrPromptAudio({ organizationId, flowId, file }),
    onSuccess: (objectFileId) => {
      setPreviewUrl(null);
      onChange({ ...prompt, audio_file_id: objectFileId });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Recording not uploaded',
        description: error instanceof Error ? error.message : 'Use an MP3 or WAV up to 5 MB.',
      }),
  });
  const preview = useMutation({
    meta: { toast: false },
    mutationFn: (objectFileId: string) => createAudioPreviewUrl(objectFileId),
    onSuccess: setPreviewUrl,
  });
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Textarea
        value={prompt.text ?? ''}
        maxLength={500}
        rows={2}
        placeholder="Words TeleCMI speaks, e.g. Press 1 for yes, 2 for no."
        onChange={(event) => onChange({ ...prompt, text: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={prompt.language || DEFAULT_LANGUAGE}
          onValueChange={(value) =>
            onChange({ ...prompt, language: value === DEFAULT_LANGUAGE ? undefined : value })
          }
        >
          <SelectTrigger className="h-8 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_LANGUAGE}>Connection language</SelectItem>
            {autoIvrLanguages.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          ref={fileInput}
          type="file"
          accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = '';
          }}
        />
        {prompt.audio_file_id ? (
          <>
            <Badge variant="violet">
              <FileAudio className="mr-1 size-3" /> Recording replaces the text
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={preview.isPending}
              onClick={() => preview.mutate(prompt.audio_file_id as string)}
            >
              Play
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPreviewUrl(null);
                onChange({ ...prompt, audio_file_id: null });
              }}
            >
              <X className="size-4" /> Remove recording
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="size-4" /> {upload.isPending ? 'Uploading…' : 'Upload recording'}
          </Button>
        )}
      </div>
      {previewUrl ? <audio controls src={previewUrl} className="h-9 w-full max-w-md" /> : null}
    </div>
  );
}

function SetEditor({
  value,
  onChange,
}: {
  value: AutoIvrSet;
  onChange: (set: AutoIvrSet) => void;
}) {
  const entry = autoIvrFields.find((item) => item.field === value.field);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.field}
        onValueChange={(field) => onChange({ field, value: defaultSetValue(field) })}
      >
        <SelectTrigger className="h-8 w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {autoIvrFields.map((item) => (
            <SelectItem key={item.field} value={item.field}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {entry?.kind === 'choice' ? (
        <Select
          value={String(value.value)}
          onValueChange={(next) => onChange({ ...value, value: next })}
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entry.choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : entry?.kind === 'boolean' ? (
        <Select
          value={value.value === true ? 'yes' : 'no'}
          onValueChange={(next) => onChange({ ...value, value: next === 'yes' })}
        >
          <SelectTrigger className="h-8 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="yes">Yes</SelectItem>
            <SelectItem value="no">No</SelectItem>
          </SelectContent>
        </Select>
      ) : entry?.kind === 'text' ? (
        <Input
          className="h-8 w-56"
          value={String(value.value)}
          maxLength={entry.field === 'purchase_timeline' ? 60 : 120}
          placeholder="Value"
          onChange={(event) => onChange({ ...value, value: event.target.value })}
        />
      ) : null}
    </div>
  );
}

function NextSelect({
  value,
  nodeIds,
  definition,
  exclude,
  onChange,
}: {
  value: string;
  nodeIds: string[];
  definition: AutoIvrDefinition;
  exclude: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={END_NODE}>End the call</SelectItem>
        {nodeIds
          .filter((id) => id !== exclude)
          .map((id) => (
            <SelectItem key={id} value={id}>
              Go to: {definition.nodes[id]?.title || id}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function QuestionCard({
  nodeId,
  node,
  index,
  definition,
  organizationId,
  flowId,
  onChange,
  onRemove,
}: {
  nodeId: string;
  node: AutoIvrNode;
  index: number;
  definition: AutoIvrDefinition;
  organizationId: string;
  flowId: string;
  onChange: (node: AutoIvrNode) => void;
  onRemove: () => void;
}) {
  const nodeIds = Object.keys(definition.nodes);
  const usedKeys = new Set(node.options.map((option) => option.key));
  const setOption = (optionIndex: number, option: AutoIvrOption) =>
    onChange({
      ...node,
      options: node.options.map((item, position) => (position === optionIndex ? option : item)),
    });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline">Q{index + 1}</Badge>
          {definition.start === nodeId ? <Badge variant="info">First question</Badge> : null}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="size-4" /> Delete
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label>Short title</Label>
          <Input
            value={node.title}
            maxLength={120}
            onChange={(event) => onChange({ ...node, title: event.target.value })}
          />
        </div>
        <PromptEditor
          label="What the customer hears"
          prompt={node.prompt}
          organizationId={organizationId}
          flowId={flowId}
          onChange={(prompt) => onChange({ ...node, prompt })}
        />
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label>Wait for a key (s)</Label>
            <Input
              type="number"
              className="h-8 w-24"
              min={3}
              max={15}
              value={node.timeout_sec}
              onChange={(event) => onChange({ ...node, timeout_sec: Number(event.target.value) })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Repeat if no key</Label>
            <Select
              value={String(node.retries)}
              onValueChange={(value) => onChange({ ...node, retries: Number(value) })}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Never</SelectItem>
                <SelectItem value="1">Once</SelectItem>
                <SelectItem value="2">Twice</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Then, if still nothing</Label>
            <NextSelect
              value={node.on_no_input}
              nodeIds={nodeIds}
              definition={definition}
              exclude={nodeId}
              onChange={(value) => onChange({ ...node, on_no_input: value })}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Keys</Label>
          {node.options.map((option, optionIndex) => (
            <div key={`${option.key}-${optionIndex}`} className="grid gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={option.key}
                  onValueChange={(key) => setOption(optionIndex, { ...option, key })}
                >
                  <SelectTrigger className="h-8 w-20" aria-label="Key">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ivrKeys
                      .filter((key) => key === option.key || !usedKeys.has(key))
                      .map((key) => (
                        <SelectItem key={key} value={key}>
                          Press {key}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 w-56"
                  value={option.label}
                  maxLength={80}
                  placeholder="Meaning, e.g. Interested"
                  onChange={(event) =>
                    setOption(optionIndex, { ...option, label: event.target.value })
                  }
                />
                <NextSelect
                  value={option.next}
                  nodeIds={nodeIds}
                  definition={definition}
                  exclude={nodeId}
                  onChange={(next) => setOption(optionIndex, { ...option, next })}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove key ${option.key}`}
                  disabled={node.options.length <= 1}
                  onClick={() =>
                    onChange({
                      ...node,
                      options: node.options.filter((_, position) => position !== optionIndex),
                    })
                  }
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="grid gap-2 pl-1">
                {(option.sets ?? []).map((set, setIndex) => (
                  <div key={setIndex} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Suggest</span>
                    <SetEditor
                      value={set}
                      onChange={(next) =>
                        setOption(optionIndex, {
                          ...option,
                          sets: (option.sets ?? []).map((item, position) =>
                            position === setIndex ? next : item,
                          ),
                        })
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Remove field"
                      onClick={() =>
                        setOption(optionIndex, {
                          ...option,
                          sets: (option.sets ?? []).filter((_, position) => position !== setIndex),
                        })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                {(option.sets ?? []).length < 5 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-fit"
                    onClick={() =>
                      setOption(optionIndex, {
                        ...option,
                        sets: [
                          ...(option.sets ?? []),
                          { field: 'temperature', value: defaultSetValue('temperature') },
                        ],
                      })
                    }
                  >
                    <Plus className="size-4" /> Fill a CRM field
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {node.options.length < 10 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                const key = ivrKeys.find((candidate) => !usedKeys.has(candidate)) ?? '9';
                onChange({
                  ...node,
                  options: [...node.options, { key, label: '', next: END_NODE, sets: [] }],
                });
              }}
            >
              <Plus className="size-4" /> Add key
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function AutoIvrFlowBuilder({ flowId }: { flowId: string }) {
  const flow = useQuery({
    queryKey: autoIvrFlowKey(flowId),
    queryFn: ({ signal }) => fetchAutoIvrFlow(flowId, signal),
  });
  if (flow.isError)
    return (
      <Alert>
        <AlertTitle>This flow could not be opened</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void flow.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!flow.data)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  return <FlowEditor key={flow.data.id} flow={flow.data} />;
}

function FlowEditor({ flow }: { flow: AutoIvrFlowRecord }) {
  const queryClient = useQueryClient();
  const flowId = flow.id;
  const [name, setName] = useState(flow.name);
  const [definition, setDefinition] = useState<AutoIvrDefinition>(flow.draft_definition);
  const [version, setVersion] = useState(flow.version);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(flow.validation_error);

  const update = (next: AutoIvrDefinition) => {
    setDefinition(next);
    setDirty(true);
  };

  const save = useMutation({
    meta: { toast: false },
    mutationFn: () => saveAutoIvrFlowDraft({ flowId, name, definition, expectedVersion: version }),
    onSuccess: async (saved) => {
      setVersion(saved.version);
      setProblem(saved.validation_error);
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: autoIvrFlowKey(flowId) });
      toast.add({ type: 'success', title: 'Draft saved' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Draft not saved',
        description: autoCallErrorMessage(error, 'Check the flow and try again.'),
      }),
  });
  const publish = useMutation({
    meta: { toast: false },
    mutationFn: () => publishAutoIvrFlow(flowId, version),
    onSuccess: async (published) => {
      setVersion(published.version);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: autoIvrFlowKey(flowId) }),
        queryClient.invalidateQueries({ queryKey: autoCallAdminKey }),
      ]);
      toast.add({
        type: 'success',
        title: `Published version ${published.published_version_no}`,
        description: 'New auto calls use it. Calls already running keep their version.',
      });
    },
    onError: (error) => {
      const message = autoCallErrorMessage(error, 'The flow could not be published.');
      setProblem(message);
      toast.add({ type: 'error', title: 'Not published', description: message });
    },
  });

  const nodeIds = Object.keys(definition.nodes);
  const organizationId = flow.organization_id;

  return (
    <div className="grid gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="grid gap-2">
          <Link
            href="/client-admin/integrations"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> Integrations
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={name}
              maxLength={120}
              aria-label="Flow name"
              className="h-10 w-72 text-lg font-semibold"
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
              }}
            />
            {flow.published_version_no ? (
              <Badge variant="success">Published v{flow.published_version_no}</Badge>
            ) : (
              <Badge variant="secondary">Draft</Badge>
            )}
            {dirty || flow.has_unpublished_changes ? (
              <Badge variant="warning">Unpublished changes</Badge>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Each question takes one key. A key can fill CRM fields; the telecaller reviews every
            suggestion before it changes the lead.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!dirty || save.isPending || name.trim().length < 2}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            disabled={dirty || publish.isPending || Boolean(problem)}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </div>

      {problem ? (
        <Alert>
          <AlertTitle>Fix this before publishing</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : dirty ? (
        <p className="text-sm text-muted-foreground">Save the draft to check it and publish.</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Opening and closing</CardTitle>
          <CardDescription>
            The greeting plays once before the first question. Say it is an automated call.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <PromptEditor
            label="Greeting"
            prompt={definition.greeting ?? { text: '' }}
            organizationId={organizationId}
            flowId={flowId}
            onChange={(greeting) => update({ ...definition, greeting })}
          />
          <PromptEditor
            label="Goodbye"
            prompt={definition.goodbye}
            organizationId={organizationId}
            flowId={flowId}
            onChange={(goodbye) => update({ ...definition, goodbye })}
          />
          <div className="grid gap-1.5">
            <Label>First question</Label>
            <Select
              value={definition.start}
              onValueChange={(start) => update({ ...definition, start })}
            >
              <SelectTrigger className="w-72">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {nodeIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {definition.nodes[id]?.title || id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {nodeIds.map((id, index) => (
        <QuestionCard
          key={id}
          nodeId={id}
          node={definition.nodes[id]}
          index={index}
          definition={definition}
          organizationId={organizationId}
          flowId={flowId}
          onChange={(node) => update({ ...definition, nodes: { ...definition.nodes, [id]: node } })}
          onRemove={() => update(removeQuestion(definition, id))}
        />
      ))}

      {nodeIds.length < 20 ? (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => {
            const id = newNodeId(definition);
            update({
              ...definition,
              start: definition.start || id,
              nodes: { ...definition.nodes, [id]: blankQuestion() },
            });
          }}
        >
          <Plus className="size-4" /> Add question
        </Button>
      ) : null}
    </div>
  );
}
