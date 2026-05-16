export class Counter {
  private _count = 0;

  increment(): void {
    this._count++;
  }

  decrement(): void {
    this._count--;
  }

  get value(): number {
    return this._count - 1;
  }
}
