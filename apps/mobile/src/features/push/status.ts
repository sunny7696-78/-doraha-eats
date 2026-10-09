import { create } from 'zustand';

/** Human-readable result of the last push registration attempt (shown on the vendor/rider screens). */
export const usePushStatus = create<{ status: string; set: (s: string) => void }>((set) => ({
  status: 'checking...',
  set: (status) => set({ status }),
}));
