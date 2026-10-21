import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { PrimaryButton } from '@/components/ui/basics';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import {
  chooseRecordingFolder,
  syncRecordings,
  type RecorderFolderGuess,
} from '@/lib/recording-sync';
import { colors, font } from '@/theme';

export type RecorderFolderOffer = RecorderFolderGuess | 'NOT_FOUND';

// Shown once, after the first call made with no recorder folder chosen. When
// the dialer's recording was found, the picker opens on its folder and the
// user only confirms; otherwise it explains how to switch recording on.
export function RecorderFolderOfferSheet({
  offer,
  onClose,
}: {
  offer: RecorderFolderOffer;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (offer === 'NOT_FOUND') {
    return (
      <Sheet
        title="Sync call recordings"
        subtitle="No recording was found for this call"
        onClose={onClose}
        footer={
          <>
            <PrimaryButton
              label="Not now"
              variant="secondary"
              onPress={onClose}
              style={styles.grow}
            />
            <PrimaryButton
              label="Choose folder"
              icon="folder-open-outline"
              style={styles.grow}
              onPress={() => {
                onClose();
                router.push('/recordings');
              }}
            />
          </>
        }
      >
        <Text style={styles.body}>
          Turn on call recording in your phone&apos;s dialer, then choose the folder it saves to.
          New calls will upload to the CRM and appear on the lead.
        </Text>
      </Sheet>
    );
  }
  return (
    <Sheet
      title="Sync this call's recording?"
      subtitle={`Found in “${offer.label}”`}
      onClose={onClose}
      footer={
        <>
          <PrimaryButton
            label="Not now"
            variant="secondary"
            onPress={onClose}
            style={styles.grow}
          />
          <PrimaryButton
            label="Use this folder"
            icon="checkmark"
            busy={busy}
            style={styles.grow}
            onPress={async () => {
              setBusy(true);
              try {
                const folder = await chooseRecordingFolder(offer.initialUri);
                onClose();
                if (!folder) return;
                toast({ message: `Watching “${folder.name}”. Syncing now…` });
                const result = await syncRecordings();
                if (result.synced)
                  toast({
                    tone: 'success',
                    message: `${result.synced} recording${result.synced > 1 ? 's' : ''} synced`,
                  });
              } catch {
                toast({ tone: 'error', message: 'That folder could not be opened. Try again.' });
              } finally {
                setBusy(false);
              }
            }}
          />
        </>
      }
    >
      <Text style={styles.body}>
        Your phone saves call recordings here. Allow the CRM to read this folder on the next screen
        (tap “Use this folder”, then “Allow”), and each call&apos;s recording will upload to your
        company&apos;s storage and appear on the lead automatically.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  body: { color: colors.text, fontSize: font.body, lineHeight: 22 },
});
