import { create } from 'zustand';
import { getSettings, putSettings, DEFAULT_SETTINGS } from '@/db/meta';
import { scheduleSettingsSync } from '@/sync/trigger';
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
    // updatedAt 是设置能跨设备定序的唯一依据（§0 变更 28 / §2.4）——
    // **只有这里写它**，所以任何绕过 store 直接 putSettings 的地方都会让合并失去准绳。
    const next = { ...get().settings, ...patch, updatedAt: Date.now() };
    await putSettings(next);
    set({ settings: next });
    scheduleSettingsSync();
  },
}));
