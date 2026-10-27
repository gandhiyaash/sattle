/** This install's id for what it reports of itself, kept beside the account token in secure storage. */

import * as SecureStore from 'expo-secure-store';

import { newDeviceId } from './tracker';

const KEY = 'sattle.device';

export async function readDeviceId(): Promise<string> {
  const kept = await SecureStore.getItemAsync(KEY);
  if (kept) return kept;
  const made = newDeviceId();
  await SecureStore.setItemAsync(KEY, made);
  return made;
}
