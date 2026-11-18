// A computer beats every half minute (POST /api/presence); missing three
// beats, it is taken for gone.
export const BEAT_WITHIN_MS = 90_000;

// Which computers are here right now: their event stream is open and they
// beat lately. The stream alone is not enough: behind the proxy, a computer
// that went to sleep leaves a half-open connection that takes many minutes
// to close, and its AIs would be woken for nothing meanwhile.
export class Presence {
  private open = new Map<string, number>();
  private beats = new Map<string, number>();

  constructor(private now: () => number = () => Date.now()) {}

  // Returns what to call when that stream closes. Opening it counts as a beat.
  connect(deviceId: string): () => void {
    this.open.set(deviceId, (this.open.get(deviceId) ?? 0) + 1);
    this.beat(deviceId);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const left = (this.open.get(deviceId) ?? 1) - 1;
      if (left > 0) this.open.set(deviceId, left);
      else this.open.delete(deviceId);
    };
  }

  beat(deviceId: string): void {
    this.beats.set(deviceId, this.now());
  }

  online(deviceId: string | null | undefined): boolean {
    if (!deviceId || (this.open.get(deviceId) ?? 0) === 0) return false;
    return this.now() - (this.beats.get(deviceId) ?? 0) <= BEAT_WITHIN_MS;
  }
}
