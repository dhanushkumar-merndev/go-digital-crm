'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  fetchBranchAccessOptions,
  fetchTeamAdministrationOptions,
  saveBranch,
  saveTeam,
  setTeamMember,
  setUserBranchAccess,
  type BranchAdministrationRecord,
  type TeamAdministrationRecord,
  type TeamCandidate,
} from './branch-team-api';
import { isAdministrationVersionConflict } from './branch-team-query';

function safeAdministrationMutationMessage(error: unknown) {
  if (isAdministrationVersionConflict(error))
    return 'This configuration changed after you opened it. Refresh the workspace and try again.';
  const message =
    typeof error === 'object' && error !== null ? (error as { message?: string }).message : null;
  const safeMessages: Record<string, string> = {
    BRANCH_NAME_OR_CODE_EXISTS: 'Another active branch already uses this name or code.',
    BRANCH_HAS_ACTIVE_DEPENDENCIES:
      'Move or close active teams, users, work, stock, cases, and integrations before deactivation.',
    TEAM_NAME_EXISTS: 'A team with this name already exists in the selected branch.',
    TEAM_HAS_ACTIVE_DEPENDENCIES:
      'Remove active members and close or reassign current workload before deactivation.',
    USER_ALREADY_IN_ACTIVE_TEAM:
      'This user already belongs to an active team. Enable the move option to transfer them.',
    INVALID_TEAM_MANAGER: 'The selected manager is not eligible for this branch.',
    INVALID_TEAM_MEMBER: 'The selected user role or branch scope is not eligible for this team.',
    MOVE_SOURCE_SCOPE_DENIED: 'You cannot move this user from a team outside your current scope.',
  };
  return (
    (message && safeMessages[message]) ||
    'The change could not be saved. Reference: GDM-ADMIN-MUTATION.'
  );
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function BranchEditorDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record: BranchAdministrationRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(record?.name ?? '');
  const [code, setCode] = useState(record?.code ?? '');
  const [line1, setLine1] = useState(textValue(record?.address.line1));
  const [line2, setLine2] = useState(textValue(record?.address.line2));
  const [city, setCity] = useState(record?.city ?? '');
  const [state, setState] = useState(record?.state ?? '');
  const [postalCode, setPostalCode] = useState(record?.postal_code ?? '');
  const [phone, setPhone] = useState(record?.contact_phone ?? '');
  const [email, setEmail] = useState(record?.contact_email ?? '');
  const [timezone, setTimezone] = useState(record?.timezone ?? 'Asia/Kolkata');
  const [category, setCategory] = useState(record?.showroom_category ?? '');
  const [latitude, setLatitude] = useState(record?.latitude?.toString() ?? '');
  const [longitude, setLongitude] = useState(record?.longitude?.toString() ?? '');
  const [workingHours, setWorkingHours] = useState(
    JSON.stringify(record?.working_hours ?? {}, null, 2),
  );
  const [active, setActive] = useState(record?.active ?? true);
  const [requestId] = useState(() => crypto.randomUUID());
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      let parsedWorkingHours: Record<string, unknown>;
      try {
        const parsed = JSON.parse(workingHours || '{}') as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new Error('INVALID_WORKING_HOURS');
        parsedWorkingHours = parsed as Record<string, unknown>;
      } catch {
        throw new Error('INVALID_WORKING_HOURS');
      }
      return saveBranch({
        id: record?.id,
        expectedVersion: record?.version,
        name,
        code,
        address: {
          line1: line1.trim(),
          line2: line2.trim(),
          city: city.trim(),
          state: state.trim(),
          postal_code: postalCode.trim(),
        },
        contactPhone: phone.trim() || null,
        contactEmail: email.trim() || null,
        timezone,
        workingHours: parsedWorkingHours,
        showroomCategory: category.trim() || null,
        latitude: latitude.trim() ? Number(latitude) : null,
        longitude: longitude.trim() ? Number(longitude) : null,
        active,
        requestId,
      });
    },
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
    },
  });
  const submit = () => {
    if (name.trim().length < 2 || code.trim().length < 2) {
      setValidationError('Enter a branch name and code.');
      return;
    }
    if (!city.trim() || !state.trim() || !postalCode.trim()) {
      setValidationError('City, state, and PIN / postal code are required.');
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidationError('Enter a valid contact email.');
      return;
    }
    if (Boolean(latitude.trim()) !== Boolean(longitude.trim())) {
      setValidationError('Enter both latitude and longitude, or leave both empty.');
      return;
    }
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (
      (latitude.trim() && (!Number.isFinite(parsedLatitude) || Math.abs(parsedLatitude) > 90)) ||
      (longitude.trim() && (!Number.isFinite(parsedLongitude) || Math.abs(parsedLongitude) > 180))
    ) {
      setValidationError('Latitude must be −90 to 90 and longitude must be −180 to 180.');
      return;
    }
    setValidationError(null);
    mutation.mutate();
  };
  const mutationMessage =
    mutation.error instanceof Error && mutation.error.message === 'INVALID_WORKING_HOURS'
      ? 'Working hours must be a valid JSON object.'
      : mutation.isError
        ? safeAdministrationMutationMessage(mutation.error)
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit branch' : 'Create branch'}</DialogTitle>
          <DialogDescription>
            Branch identity, contact, operating hours, and status are audited together.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="branch-name">Branch name</Label>
            <Input
              id="branch-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-code">Branch code</Label>
            <Input
              id="branch-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={24}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="branch-line-1">Address</Label>
            <Input
              id="branch-line-1"
              value={line1}
              onChange={(event) => setLine1(event.target.value)}
              placeholder="Street / building"
              maxLength={240}
            />
            <Input
              value={line2}
              onChange={(event) => setLine2(event.target.value)}
              placeholder="Area / landmark (optional)"
              maxLength={240}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-city">City</Label>
            <Input
              id="branch-city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-state">State</Label>
            <Input
              id="branch-state"
              value={state}
              onChange={(event) => setState(event.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-postal">PIN / postal code</Label>
            <Input
              id="branch-postal"
              value={postalCode}
              onChange={(event) => setPostalCode(event.target.value)}
              maxLength={24}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-category">Showroom category</Label>
            <Input
              id="branch-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Main showroom, satellite…"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-phone">Contact phone</Label>
            <Input
              id="branch-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={32}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-email">Contact email</Label>
            <Input
              id="branch-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
            />
          </div>
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Asia/Kolkata">Asia/Kolkata</SelectItem>
                <SelectItem value="Asia/Dubai">Asia/Dubai</SelectItem>
                <SelectItem value="UTC">UTC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Button
              type="button"
              variant={active ? 'default' : 'outline'}
              className="w-full justify-start"
              onClick={() => setActive((value) => !value)}
            >
              {active ? 'Active' : 'Inactive'}
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-latitude">Latitude (optional)</Label>
            <Input
              id="branch-latitude"
              inputMode="decimal"
              value={latitude}
              onChange={(event) => setLatitude(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-longitude">Longitude (optional)</Label>
            <Input
              id="branch-longitude"
              inputMode="decimal"
              value={longitude}
              onChange={(event) => setLongitude(event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="branch-hours">Working hours</Label>
            <Textarea
              id="branch-hours"
              rows={5}
              value={workingHours}
              onChange={(event) => setWorkingHours(event.target.value)}
              placeholder={'{"monday":{"opens":"09:00","closes":"18:00"}}'}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Store day-specific opening and closing times as a JSON object.
            </p>
          </div>
        </div>
        {!active && record?.active && (
          <div className="mt-4 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            Deactivation succeeds only after every active dependency has been moved, closed, or
            unmapped.
          </div>
        )}
        {(validationError || mutationMessage) && (
          <p className="mt-4 text-sm text-destructive">{validationError ?? mutationMessage}</p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : record ? 'Save branch' : 'Create branch'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TeamEditorDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record: TeamAdministrationRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [branchId, setBranchId] = useState(record?.branch_id ?? '');
  const [name, setName] = useState(record?.name ?? '');
  const [managerId, setManagerId] = useState(record?.manager_id ?? 'none');
  const [freshMode, setFreshMode] = useState<'ROUND_ROBIN' | 'MANUAL_ASSIGNMENT'>(
    record?.fresh_assignment_mode ?? 'ROUND_ROBIN',
  );
  const [qualifiedMode, setQualifiedMode] = useState<'ROUND_ROBIN' | 'MANUAL_ASSIGNMENT'>(
    record?.qualified_assignment_mode ?? 'ROUND_ROBIN',
  );
  const [active, setActive] = useState(record?.active ?? true);
  const [requestId] = useState(() => crypto.randomUUID());
  const [validationError, setValidationError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: ['team-administration-options', branchId || null, record?.id ?? null],
    queryFn: () => fetchTeamAdministrationOptions(branchId || null, record?.id ?? null),
    enabled: open,
    staleTime: 60_000,
  });
  const managers = (options.data?.users ?? []).filter(
    (user) => user.member_type === 'TEAM_MANAGER' && !user.other_team_id,
  );
  const mutation = useMutation({
    mutationFn: () =>
      saveTeam({
        id: record?.id,
        expectedVersion: record?.version,
        branchId,
        name,
        managerId: managerId === 'none' ? null : managerId,
        freshMode,
        qualifiedMode,
        active,
        requestId,
      }),
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
    },
  });
  const submit = () => {
    if (!branchId || name.trim().length < 2) {
      setValidationError('Select a branch and enter a team name.');
      return;
    }
    setValidationError(null);
    mutation.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit team' : 'Create team'}</DialogTitle>
          <DialogDescription>
            Configure separate fresh-lead and qualified-lead assignment modes. Round Robin remains
            the default.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Branch</Label>
            <Select
              value={branchId}
              onValueChange={(value) => {
                setBranchId(value);
                setManagerId('none');
              }}
              disabled={Boolean(record)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {(options.data?.branches ?? []).map((branch) => (
                  <SelectItem key={branch.id} value={branch.id} disabled={!branch.active}>
                    {branch.name} ({branch.code}){branch.active ? '' : ' · inactive'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Team manager</Label>
            <Select value={managerId} onValueChange={setManagerId}>
              <SelectTrigger>
                <SelectValue placeholder="No manager assigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No manager assigned</SelectItem>
                {managers.map((manager) => (
                  <SelectItem key={manager.id} value={manager.id}>
                    {manager.name} · {manager.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Fresh-lead assignment</Label>
            <Select
              value={freshMode}
              onValueChange={(value) => setFreshMode(value as typeof freshMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ROUND_ROBIN">Round Robin</SelectItem>
                <SelectItem value="MANUAL_ASSIGNMENT">Manual Assignment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Qualified-lead assignment</Label>
            <Select
              value={qualifiedMode}
              onValueChange={(value) => setQualifiedMode(value as typeof qualifiedMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ROUND_ROBIN">Round Robin</SelectItem>
                <SelectItem value="MANUAL_ASSIGNMENT">Manual Assignment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {record && (
            <div className="space-y-2 sm:col-span-2">
              <Label>Status</Label>
              <Button
                type="button"
                variant={active ? 'default' : 'outline'}
                className="w-full justify-start"
                onClick={() => setActive((value) => !value)}
              >
                {active ? 'Active' : 'Inactive'}
              </Button>
            </div>
          )}
        </div>
        {(validationError || mutation.isError) && (
          <p className="mt-4 text-sm text-destructive">
            {validationError ?? safeAdministrationMutationMessage(mutation.error)}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending || options.isPending}>
            {mutation.isPending ? 'Saving…' : record ? 'Save team' : 'Create team'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function candidateLabel(candidate: TeamCandidate) {
  const type = candidate.member_type.replaceAll('_', ' ');
  return `${candidate.name} · ${type}`;
}

export function TeamMembersDialog({
  team,
  open,
  onOpenChange,
  onSaved,
}: {
  team: TeamAdministrationRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [userId, setUserId] = useState('');
  const [eligibleFresh, setEligibleFresh] = useState(false);
  const [eligibleQualified, setEligibleQualified] = useState(false);
  const [moveExisting, setMoveExisting] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const options = useQuery({
    queryKey: ['team-administration-options', team.branch_id, team.id, debouncedSearch],
    queryFn: () => fetchTeamAdministrationOptions(team.branch_id, team.id, debouncedSearch),
    enabled: open,
  });
  const selected = options.data?.users.find((user) => user.id === userId);
  const mutation = useMutation({
    mutationFn: ({ candidate, active }: { candidate: TeamCandidate; active: boolean }) =>
      setTeamMember({
        teamId: team.id,
        expectedTeamVersion: team.version,
        userId: candidate.id,
        memberType: candidate.member_type,
        active,
        eligibleForFresh: active ? eligibleFresh : Boolean(candidate.eligible_for_fresh_leads),
        eligibleForQualified: active
          ? eligibleQualified
          : Boolean(candidate.eligible_for_qualified_leads),
        moveFromExisting: moveExisting,
        requestId,
      }),
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage {team.name} members</DialogTitle>
          <DialogDescription>
            Role and branch eligibility are enforced by the database. Moving a member is atomic and
            audited.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder="Search eligible users…"
              maxLength={160}
            />
          </div>
          <Select
            value={userId}
            onValueChange={(value) => {
              setUserId(value);
              const candidate = options.data?.users.find((user) => user.id === value);
              setEligibleFresh(Boolean(candidate?.eligible_for_fresh_leads));
              setEligibleQualified(Boolean(candidate?.eligible_for_qualified_leads));
              setMoveExisting(false);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select an eligible user" />
            </SelectTrigger>
            <SelectContent>
              {(options.data?.users ?? []).map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidateLabel(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <div className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{selected.name}</p>
                  <p className="text-sm text-muted-foreground">{selected.email}</p>
                </div>
                <StatusBadge value={selected.membership_active ? 'ACTIVE' : 'NOT ASSIGNED'} />
              </div>
              {selected.other_team_name && (
                <p className="mt-3 text-sm text-amber-700">
                  Current active team: {selected.other_team_name}
                </p>
              )}
              {selected.member_type !== 'TEAM_MANAGER' && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={eligibleFresh ? 'default' : 'outline'}
                    onClick={() => setEligibleFresh((value) => !value)}
                  >
                    Fresh-lead eligible
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={eligibleQualified ? 'default' : 'outline'}
                    onClick={() => setEligibleQualified((value) => !value)}
                  >
                    Qualified-lead eligible
                  </Button>
                </div>
              )}
              {selected.other_team_id && (
                <Button
                  type="button"
                  size="sm"
                  variant={moveExisting ? 'default' : 'outline'}
                  className="mt-3"
                  onClick={() => setMoveExisting((value) => !value)}
                >
                  Move from existing team
                </Button>
              )}
              <div className="mt-5 flex justify-end gap-2">
                {selected.membership_active && (
                  <Button
                    variant="outline"
                    onClick={() => mutation.mutate({ candidate: selected, active: false })}
                    disabled={mutation.isPending}
                  >
                    Remove from team
                  </Button>
                )}
                <Button
                  onClick={() => mutation.mutate({ candidate: selected, active: true })}
                  disabled={mutation.isPending || Boolean(selected.other_team_id && !moveExisting)}
                >
                  {selected.membership_active ? 'Update eligibility' : 'Add to team'}
                </Button>
              </div>
            </div>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {safeAdministrationMutationMessage(mutation.error)}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BranchAccessDialog({
  branch,
  open,
  onOpenChange,
  onSaved,
}: {
  branch: BranchAdministrationRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const options = useQuery({
    queryKey: ['branch-access-options', branch.id, debouncedSearch],
    queryFn: () => fetchBranchAccessOptions(branch.id, debouncedSearch),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: ({
      user,
      requestId,
    }: {
      user: NonNullable<typeof options.data>['users'][number];
      requestId: string;
    }) =>
      setUserBranchAccess({
        branchId: branch.id,
        userId: user.id,
        expectedVersion: user.access_version,
        grantAccess: !user.explicit_access,
        requestId,
      }),
    onSuccess: () => {
      void options.refetch();
      onSaved();
    },
  });
  const users = useMemo(() => options.data?.users ?? [], [options.data?.users]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{branch.name} access</DialogTitle>
          <DialogDescription>
            Explicit access is supplemental to assignment and team scope. Inherited access must be
            changed at its source.
          </DialogDescription>
        </DialogHeader>
        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Search user, email, or employee ID…"
            maxLength={160}
          />
        </div>
        <div className="mt-4 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access source</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <p className="font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </TableCell>
                  <TableCell>{user.roles}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.explicit_access && <Badge variant="secondary">Explicit</Badge>}
                      {user.inherited_access && <Badge variant="outline">Inherited</Badge>}
                      {!user.explicit_access && !user.inherited_access && (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={user.explicit_access ? 'outline' : 'default'}
                      onClick={() => mutation.mutate({ user, requestId: crypto.randomUUID() })}
                      disabled={mutation.isPending}
                    >
                      {user.explicit_access ? 'Revoke explicit' : 'Grant explicit'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!users.length && !options.isPending && (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No manageable users match this search.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {mutation.isError && (
          <p className="mt-4 text-sm text-destructive">
            {safeAdministrationMutationMessage(mutation.error)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
