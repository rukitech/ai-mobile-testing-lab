import type { ScreenProfileName } from './protocol.ts';

/**
 * Android screen profiles applied with `wm size` / `wm density` to a running
 * emulator. They approximate a device class (smallestWidth reacts), but the
 * system UI and reported model stay the phone's. See ARCHITECTURE.md §2.
 * smallestWidth(dp) = min(w,h) / (density/160).
 */
export const ANDROID_SCREEN_PROFILES: Record<Exclude<ScreenProfileName, 'reset'>, { width: number; height: number; density: number; label: string }> = {
  phone: { width: 1080, height: 2400, density: 420, label: 'Phone ~6.4" (sw411dp)' },
  'tablet-7': { width: 1200, height: 1920, density: 320, label: 'Tablet 7" (sw600dp)' },
  'tablet-10': { width: 1600, height: 2560, density: 320, label: 'Tablet 10" (sw800dp)' },
};

export function smallestWidthDp(width: number, height: number, density: number): number {
  return Math.round(Math.min(width, height) / (density / 160));
}
