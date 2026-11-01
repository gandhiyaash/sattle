/** Whether the device has asked where to be paid, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

const KEY = 'sattle.getPaidAsked';

export const readGetPaidAsked = async (): Promise<boolean> => (await SecureStore.getItemAsync(KEY)) === '1';
export const writeGetPaidAsked = (): Promise<void> => SecureStore.setItemAsync(KEY, '1');
