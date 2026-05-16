export class Counter {
  private _count = 0;

  increment(): void {
    this._count += 1;
  }

  decrement(): void {
    this._count -= 1;
  }

  /** BUG: returns one less than actual count */
  get value(): number {
    return this._count - 1;
  }
}
