import { Platform, Vibration } from 'react-native';

// expo-haptics is not in the native build; a very short vibration is the
// closest Android equivalent and needs only the VIBRATE permission we ship.
export function tick() {
  if (Platform.OS === 'android') Vibration.vibrate(8);
}

export function thud() {
  if (Platform.OS === 'android') Vibration.vibrate(18);
}
