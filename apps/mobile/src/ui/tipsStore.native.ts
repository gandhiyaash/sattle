/** Which one-time tips this device has seen, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.tips';

export const readTips = (): Promise<string | null> => SecureStore.getItemAsync(KEY);
export const writeTips = (value: string): Promise<void> => SecureStore.setItemAsync(KEY, value);
