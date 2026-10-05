/** Which currencies they use, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.currencies';

export const readCurrencies = (): Promise<string | null> => SecureStore.getItemAsync(KEY);
export const writeCurrencies = (value: string): Promise<void> => SecureStore.setItemAsync(KEY, value);
