/**
 * Order-independent randomness: a decision drawn from a stable key (a trip, a
 * patient, a date) is the same whatever else the simulation drew before, so
 * re-running the script reproduces it even when the optimizer's plan differs.
 */
import { Rng } from "../seed/random";

/** 32-bit FNV-1a hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Float in [0, 1) drawn from a key: the same key always gives the same value. */
export function unitFromKey(key: string): number {
  // Mixed through the generator: FNV alone is poorly spread on keys that differ by one character.
  return new Rng(hashString(key)).next();
}

/** Generator dedicated to one phase of one simulated day ("2026-10-12", "planning"). */
export function rngFor(seed: number, ...parts: string[]): Rng {
  return new Rng(hashString([String(seed), ...parts].join(":")));
}
