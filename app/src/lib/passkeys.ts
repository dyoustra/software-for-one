import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type * as PasskeysModule from 'react-native-passkeys';

/** The domain passkeys are bound to (SIGN_IN_SPEC §6); must match the server's. */
export const PASSKEY_DOMAIN = 'sfo.dannyyoustra.com';

type Passkeys = typeof PasskeysModule;

/**
 * Loaded on first use, not imported: a native build made before passkeys
 * existed has no such module, and a top-level import would crash it at
 * launch. Without it, passkeys are simply not offered.
 */
function module(): Passkeys | null {
  // Asked first: loading the package without its native half reports an
  // error even when caught.
  if (Platform.OS !== 'web' && !requireOptionalNativeModule('ReactNativePasskeys')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-passkeys') as Passkeys;
  } catch {
    return null;
  }
}

/**
 * Whether this device can use sfo's passkeys here: the iPhone app (tied to the
 * domain by its entitlement), or the web app only when it is served from that
 * domain, never from localhost.
 */
export function passkeysHere(): boolean {
  try {
    const m = module();
    if (!m) return false;
    if (Platform.OS === 'web') return typeof window !== 'undefined' && window.location.hostname === PASSKEY_DOMAIN && m.isSupported();
    return Platform.OS === 'ios' && m.isSupported();
  } catch {
    return false;
  }
}

type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** Makes a passkey on this device and adds it to the signed-in account. False when the person cancelled. */
export async function addPasskey(api: Api, name: string): Promise<boolean> {
  const m = module();
  if (!m) throw new Error('This build of the app has no passkey support yet.');
  const options = await api<Parameters<Passkeys['create']>[0]>('/passkeys/options', { method: 'POST' });
  const response = await m.create(options);
  if (!response) return false;
  await api('/passkeys', { method: 'POST', body: { response, name } });
  return true;
}

/** Asks the device for a passkey answer to the server's challenge. Null when the person cancelled. */
export async function passkeyAnswer(options: Parameters<Passkeys['get']>[0]) {
  const m = module();
  if (!m) throw new Error('This build of the app has no passkey support yet.');
  return m.get(options);
}
