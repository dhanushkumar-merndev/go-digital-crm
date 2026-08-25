'use client';

import { ImagePlus, LoaderCircle, Trash2, UserRoundPen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  getProfileSettingsErrorMessage,
  ProfileSettingsError,
  saveMyProfile,
  uploadProfileAvatar,
  validateProfileAvatar,
  type ProfileAvatarAction,
  type SavedProfile,
} from './profile-settings-api';

type CurrentProfile = {
  fullName: string;
  avatarObjectFileId: string | null;
  version: number;
};

function initials(value: string) {
  const result = value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return result || 'A';
}

export function ProfileSettingsDialog({
  open,
  onOpenChange,
  profile,
  organizationId,
  userId,
  currentAvatarUrl,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: CurrentProfile;
  organizationId: string | null;
  userId: string;
  currentAvatarUrl?: string;
  onSaved: (profile: SavedProfile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState(profile.fullName);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [avatarAction, setAvatarAction] = useState<ProfileAvatarAction>('KEEP');
  const [error, setError] = useState<string>();

  useEffect(
    () => () => {
      if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const normalizedName = fullName.trim().replace(/\s+/g, ' ');
      if (normalizedName.length < 2 || normalizedName.length > 160)
        throw new ProfileSettingsError('INVALID_PROFILE_NAME');

      let nextAvatarObjectFileId: string | null = null;
      if (avatarAction === 'REPLACE') {
        if (!organizationId || !selectedFile)
          throw new ProfileSettingsError('PROFILE_AVATAR_INVALID');
        nextAvatarObjectFileId = await uploadProfileAvatar({
          organizationId,
          userId,
          file: selectedFile,
        });
      }
      return saveMyProfile({
        fullName: normalizedName,
        expectedVersion: profile.version,
        avatarAction,
        avatarObjectFileId: nextAvatarObjectFileId,
      });
    },
    onSuccess: (saved) => {
      onSaved(saved);
      onOpenChange(false);
    },
    onError: (nextError) => setError(getProfileSettingsErrorMessage(nextError)),
  });

  function choosePhoto(file: File | undefined) {
    setError(undefined);
    if (!file) return;
    try {
      validateProfileAvatar(file);
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setAvatarAction('REPLACE');
    } catch (nextError) {
      setError(getProfileSettingsErrorMessage(nextError));
    }
  }

  function clearPhoto() {
    if (inputRef.current) inputRef.current.value = '';
    setSelectedFile(undefined);
    setPreviewUrl(undefined);
    setAvatarAction(profile.avatarObjectFileId ? 'REMOVE' : 'KEEP');
  }

  const visibleAvatarUrl = previewUrl ?? (avatarAction === 'REMOVE' ? undefined : currentAvatarUrl);
  const canUploadAvatar = Boolean(organizationId);
  const canRemoveAvatar = Boolean(selectedFile || profile.avatarObjectFileId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-700">
            <UserRoundPen className="size-5" />
          </div>
          <DialogTitle>My profile</DialogTitle>
          <DialogDescription>
            Update the name and photo shown across your CRM workspace.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-2 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            mutation.mutate();
          }}
        >
          <div className="flex items-center gap-4 rounded-xl border bg-slate-50/60 p-4">
            <Avatar className="size-20 border-2 border-white shadow-sm">
              {visibleAvatarUrl ? (
                <AvatarImage
                  src={visibleAvatarUrl}
                  alt={`${fullName || 'Account'} profile photo`}
                />
              ) : null}
              <AvatarFallback className="text-xl">{initials(fullName)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">Profile photo</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                JPEG, PNG or WebP, up to 5 MB.
              </p>
              {canUploadAvatar ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Input
                    ref={inputRef}
                    id="profile-photo"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(event) => choosePhoto(event.target.files?.[0])}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => inputRef.current?.click()}
                  >
                    <ImagePlus className="size-4" />
                    {profile.avatarObjectFileId || selectedFile ? 'Change photo' : 'Add photo'}
                  </Button>
                  {canRemoveAvatar ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={clearPhoto}
                    >
                      <Trash2 className="size-4" /> Remove
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Profile photo upload is available for dealership accounts.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-full-name">Display name</Label>
            <Input
              id="profile-full-name"
              value={fullName}
              maxLength={160}
              autoComplete="name"
              disabled={mutation.isPending}
              onChange={(event) => setFullName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use the name colleagues should see in the CRM.
            </p>
          </div>

          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {mutation.isPending ? 'Saving…' : 'Save profile'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
