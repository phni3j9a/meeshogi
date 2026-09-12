import { useStore } from 'zustand';
import { randomUUID } from 'expo-crypto';
import { AppState as NativeAppState } from 'react-native';
import { openRepository } from '../storage/native';
import { analyzeNative, cancelNative, ENGINE_ID, MODEL_ID } from '../analysis/native-engine';
import { makeAppStore, type AppState } from './create-app-store';
export const appStore = makeAppStore({
  openRepository,
  analyze: analyzeNative,
  cancel: cancelNative,
  engineId: ENGINE_ID,
  modelId: MODEL_ID,
  createId: randomUUID,
});
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
NativeAppState.addEventListener('change', (state) => {
  if (state !== 'active') appStore.getState().stopAnalysis();
});
