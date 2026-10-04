/** The light/dark choice, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.appearance';

export const readAppearance = (): Promise<string | null> => SecureStore.getItemAsync(KEY);
export const writeAppearance = (value: string): Promise<void> => SecureStore.setItemAsync(KEY, value);
