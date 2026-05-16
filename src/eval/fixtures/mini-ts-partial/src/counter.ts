export class Counter {
  private x = 0;

  increment(): void {
    this.x += 1;
  }

  decrement(): void {
    this.x -= 1;
  }

  get value(): number {
    return this.x;
  }

  // reset() is absent — add it
}
