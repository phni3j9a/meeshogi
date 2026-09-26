import { useStore } from 'zustand';
import { randomUUID } from 'expo-crypto';
import { AppState as NativeAppState } from 'react-native';
import { openRepository } from '../storage/native';
import { analyzeNative, cancelNative } from '../analysis/native-engine';
import { cloudEndpoint } from '../cloud/config';
import { makeCloudClient } from '../cloud/client';
import { secureStoreCredentials } from '../cloud/secure-store';
import { makeAppStore, type AppState } from './create-app-store';
export const appStore = makeAppStore({
  openRepository,
  analyze: analyzeNative,
  cancel: cancelNative,
  createId: randomUUID,
  cloud: {
    endpoint: cloudEndpoint,
    clientFor: (endpoint) => makeCloudClient(endpoint),
    credentialsFor: (endpoint) => secureStoreCredentials(endpoint),
    createId: randomUUID,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowIso: () => new Date().toISOString(),
    pollIntervalMs: 2_000,
    maxBackoffMs: 30_000,
  },
});
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
NativeAppState.addEventListener('change', (state) => {
  if (state !== 'active') {
    appStore.getState().stopAnalysis();
    appStore.getState().pauseCloudJobs();
    return;
  }
  appStore.getState().resumeCloudJobs();
});
