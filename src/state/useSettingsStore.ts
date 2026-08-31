import { create } from 'zustand';
import { getSettings, putSettings, DEFAULT_SETTINGS } from '@/db/meta';
import type { Settings } from '@/types/models';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings = await getSettings();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    await putSettings(next);
    set({ settings: next });
  },
}));
