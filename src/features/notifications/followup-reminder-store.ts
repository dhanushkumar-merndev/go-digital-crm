import { create } from 'zustand';
import type { FollowupReminder } from './followup-reminder-api';

type ReminderState = {
  scope: string;
  due: FollowupReminder[];
  enqueue: (scope: string, item: FollowupReminder) => void;
  dismiss: (id: string) => void;
  reset: () => void;
};
export const useFollowupReminderStore = create<ReminderState>((set) => ({
  scope: '',
  due: [],
  enqueue: (scope, item) =>
    set((state) => ({
      scope,
      due: [...(state.scope === scope ? state.due.filter((row) => row.id !== item.id) : []), item],
    })),
  dismiss: (id) => set((state) => ({ due: state.due.filter((row) => row.id !== id) })),
  reset: () => set({ scope: '', due: [] }),
}));
