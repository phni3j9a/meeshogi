import * as SecureStore from 'expo-secure-store';
import type { CloudCredential } from './client';
import type { CredentialProbe, CredentialStore } from './credentials';

function keyFor(endpoint: string): string {
  return `cloudCredential.${endpoint.replace(/[^A-Za-z0-9.\-_]/gu, '_').slice(0, 96)}`;
}

/** expo-secure-store backed CredentialStore, keyed per endpoint. */
export function secureStoreCredentials(endpoint: string): CredentialStore {
  const key = keyFor(endpoint);
  const decode = (raw: string | null): CredentialProbe => {
    // Absent means the key itself is missing — SecureStore returned null.
    // A stored empty string or any unreadable value is `unusable`: the entry
    // exists, so loss cannot be concluded (Plan §3 limited exception).
    if (raw === null) return { state: 'absent' };
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
        return { state: 'ok', credential: value as CloudCredential };
      }
    } catch {
      // Corrupt JSON: present but unreadable, not confirmed absent.
    }
    return { state: 'unusable' };
  };
  return {
    async load() {
      const probe = await this.probe();
      return probe.state === 'ok' ? probe.credential : null;
    },
    async save(credential) {
      await SecureStore.setItemAsync(key, JSON.stringify(credential));
    },
    async probe() {
      // A SecureStore read exception (lock/transient failure) propagates —
      // it never proves absence and callers must treat it as ineligible.
      return decode(await SecureStore.getItemAsync(key));
    },
  };
}
