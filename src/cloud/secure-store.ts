import * as SecureStore from 'expo-secure-store';
import type { CloudCredential } from './client';
import type { CredentialStore } from './credentials';

function keyFor(endpoint: string): string {
  return `cloudCredential.${endpoint.replace(/[^A-Za-z0-9.\-_]/gu, '_').slice(0, 96)}`;
}

/** expo-secure-store backed CredentialStore, keyed per endpoint. */
export function secureStoreCredentials(endpoint: string): CredentialStore {
  const key = keyFor(endpoint);
  return {
    async load() {
      const raw = await SecureStore.getItemAsync(key);
      if (!raw) return null;
      try {
        const value = JSON.parse(raw) as unknown;
        if (
          value !== null &&
          typeof value === 'object' &&
          typeof (value as CloudCredential).credential === 'string' &&
          typeof (value as CloudCredential).ownerId === 'string' &&
          typeof (value as CloudCredential).installId === 'string' &&
          (value as CloudCredential).endpoint === endpoint
        ) {
          return value as CloudCredential;
        }
      } catch {
        // Corrupt entries are treated as absent so a fresh credential is issued.
      }
      return null;
    },
    async save(credential) {
      await SecureStore.setItemAsync(key, JSON.stringify(credential));
    },
  };
}
