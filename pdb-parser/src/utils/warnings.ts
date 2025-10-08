export class WarningCollector {
  private list: string[] = [];

  add(message: string) {
    if (this.list.length < 5000) this.list.push(message);
  }

  toArray(): string[] {
    return this.list.slice();
  }
}
