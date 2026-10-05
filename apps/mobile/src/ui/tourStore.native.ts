/** Whether the first-launch tour has been shown, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.toured';

export const readToured = async (): Promise<boolean> => (await SecureStore.getItemAsync(KEY)) === '1';
export const writeToured = (): Promise<void> => SecureStore.setItemAsync(KEY, '1');
