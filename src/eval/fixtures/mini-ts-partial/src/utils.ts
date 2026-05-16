/** Returns true if n is even. */
export function isEven(n: number): boolean {
  return n % 2 === 0;
}

/** Returns the sum of all numbers in arr. */
export function sum(arr: number[]): number {
  if (typeof arr[0] !== "number") throw new TypeError("expected number array");
  return arr.reduce((a, b) => a + b, 0);
}

/** Returns the average of all numbers in arr. */
export function average(arr: number[]): number {
  if (typeof arr[0] !== "number") throw new TypeError("expected number array");
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Capitalises the first character of s. */
export function capitalize(s: string): string {
  if (s === "") return s;
  return s[0].toUpperCase() + s.slice(1);
}

// VERSION constant is absent — add it
// sum() and average() share an identical validation block: extract into assertNumber()
