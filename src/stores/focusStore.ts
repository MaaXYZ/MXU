import { create } from 'zustand';

export interface FocusDialog {
  id: string;
  instanceId: string;
  message: string;
  html?: string;
  blocking: boolean;
}
interface FocusState {
  dialogs: FocusDialog[];
  closed: Set<string>;
  enqueue: (dialog: FocusDialog) => void;
  close: (id: string) => void;
}
export const useFocusStore = create<FocusState>((set) => ({
  dialogs: [],
  closed: new Set(),
  enqueue: (dialog) =>
    set((state) =>
      state.closed.has(dialog.id) || state.dialogs.some((item) => item.id === dialog.id)
        ? state
        : { dialogs: [...state.dialogs, dialog] },
    ),
  close: (id) =>
    set((state) => ({
      dialogs: state.dialogs.filter((dialog) => dialog.id !== id),
      closed: new Set([...state.closed].slice(-999).concat(id)),
    })),
}));
