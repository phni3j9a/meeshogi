/**
 * The Cloud analysis endpoint is a build-time setting: the Expo-inlined
 * environment variable `EXPO_PUBLIC_CLOUD_ENDPOINT` (an https URL without a
 * trailing slash). It carries no secret — credentials are issued per install
 * and kept in SecureStore. When unset, Cloud methods explain that they are
 * unconfigured while Sekirei and game management keep working.
 */
export function cloudEndpoint(): string | null {
  const raw = process.env.EXPO_PUBLIC_CLOUD_ENDPOINT;
  if (!raw) return null;
  const value = raw.trim().replace(/\/+$/u, '');
  if (!/^https:\/\/[^\s]+$/u.test(value)) return null;
  return value;
}
