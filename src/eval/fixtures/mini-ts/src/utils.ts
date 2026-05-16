/** Clamps v to the range [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Returns true if n is even. */
export function isEven(n: number): boolean {
  return n % 2 === 0;
}

/** Returns the sum of all numbers in arr. */
export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

/** Capitalises the first character of s. */
export function capitalize(s: string): string {
  if (s === "") return s;
  return s[0].toUpperCase() + s.slice(1);
}
