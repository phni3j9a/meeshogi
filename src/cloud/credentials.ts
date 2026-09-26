import type { CloudCredential } from './client';

/**
 * Bound to one endpoint at construction: a record saved for another endpoint is
 * never loaded, and nothing stored here is read by the other endpoints. The
 * credential itself never enters bundles, DB rows, logs, or reports — only the
 * derived ownerId is persisted next to attempts.
 */
export interface CredentialStore {
  load(): Promise<CloudCredential | null>;
  save(credential: CloudCredential): Promise<void>;
}

export function memoryCredentialStore(
  initial: CloudCredential | null = null,
): CredentialStore & { readonly value: CloudCredential | null } {
  let stored = initial;
  const store: CredentialStore & { value: CloudCredential | null } = {
    get value() {
      return stored;
    },
    set value(next: CloudCredential | null) {
      stored = next;
    },
    async load() {
      return stored;
    },
    async save(credential) {
      stored = credential;
    },
  };
  return store;
}
