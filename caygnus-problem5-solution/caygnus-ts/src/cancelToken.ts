export class CancelToken {
  private _requested = false;

  get requested(): boolean {
    return this._requested;
  }

  cancel(): void {
    this._requested = true;
  }
}
