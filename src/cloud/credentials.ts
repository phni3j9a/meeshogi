import type { CloudCredential } from './client';

/**
 * Why a credential cannot be used right now. `absent` means the storage key
 * itself is confirmed missing — the only state that proves loss. `unusable`
 * means an entry exists but is corrupt, malformed, or bound to a different
 * endpoint: the original mapping may still exist, so absence must not be
 * concluded. Read exceptions (lock/transient errors) are thrown, not probed.
 */
export type CredentialProbe =
  | { state: 'ok'; credential: CloudCredential }
  | { state: 'absent' }
  | { state: 'unusable' };

/**
 * Bound to one endpoint at construction: a record saved for another endpoint is
 * never loaded, and nothing stored here is read by the other endpoints. The
 * credential itself never enters bundles, DB rows, logs, or reports — only the
 * derived ownerId is persisted next to attempts.
 */
export interface CredentialStore {
  load(): Promise<CloudCredential | null>;
  save(credential: CloudCredential): Promise<void>;
  /**
   * Distinguishes 'absent' (key confirmed missing) from 'unusable' (entry
   * exists but cannot be used). Used only for delete-boundary eligibility —
   * the normal reconnect path goes through load().
   */
  probe(): Promise<CredentialProbe>;
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
    async probe() {
      return stored === null ? { state: 'absent' } : { state: 'ok', credential: stored };
    },
  };
  return store;
}
