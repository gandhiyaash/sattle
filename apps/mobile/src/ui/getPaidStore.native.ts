/** Whether the device is done with asking where to be paid, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.getPaidDone';

export const readGetPaidDone = async (): Promise<boolean> => (await SecureStore.getItemAsync(KEY)) === '1';
export const writeGetPaidDone = (): Promise<void> => SecureStore.setItemAsync(KEY, '1');
