import * as SecureStore from 'expo-secure-store';

const KEY = 'sfo-device-token';

/** Where this device keeps its control-plane token: the Keychain. */
export const tokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token: string) => SecureStore.setItemAsync(KEY, token),
  clear: () => SecureStore.deleteItemAsync(KEY),
};
