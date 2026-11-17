import { Platform } from 'react-native';

import { PASSKEY_DOMAIN } from '@/lib/passkeys';

const SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

type AppleID = {
  auth: {
    init(config: { clientId: string; scope: string; redirectURI: string; usePopup: boolean }): void;
    signIn(): Promise<{ authorization: { id_token: string } }>;
  };
};

/**
 * Sign in with Apple in the deployed web app, through Apple's own script, as
 * the approval page does. Only there: Apple accepts only the return address
 * registered on the Services ID (WEB_APP_SPEC §4, §6.5).
 */
export const appleOnWeb = () => Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hostname === PASSKEY_DOMAIN;

let loaded: Promise<AppleID> | null = null;

function load(): Promise<AppleID> {
  loaded ??= new Promise<AppleID>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.onload = () => resolve((window as unknown as { AppleID: AppleID }).AppleID);
    script.onerror = () => {
      loaded = null;
      reject(new Error('Could not load Sign in with Apple'));
    };
    document.head.appendChild(script);
  });
  return loaded;
}

/** Apple's identity token for the person, after Apple's popup. */
export async function appleWebIdToken(): Promise<string> {
  const AppleID = await load();
  AppleID.auth.init({ clientId: 'com.youstra.sfo.web', scope: '', redirectURI: `${window.location.origin}/sign-in`, usePopup: true });
  const r = await AppleID.auth.signIn();
  return r.authorization.id_token;
}
