/** The account token in the OS keychain (iOS) or keystore (Android). */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.token';

export const readToken = (): Promise<string | null> => SecureStore.getItemAsync(KEY);
export const writeToken = (token: string): Promise<void> => SecureStore.setItemAsync(KEY, token);
export const clearToken = (): Promise<void> => SecureStore.deleteItemAsync(KEY);
