import { createHash } from "node:crypto";

/** Round robin without a session; rendezvous affinity with a session. */
export class SelectionPool {
  private cursors = new Map<string, number>();

  choose<T>(
    scope: string,
    candidates: readonly T[],
    identity: (item: T) => string,
    session?: string,
  ): T | undefined {
    if (!candidates.length) return;
    if (session) {
      let selected: T = candidates[0]!;
      let best = "";
      for (const candidate of candidates) {
        const score = createHash("sha256")
          .update(JSON.stringify([scope, session, identity(candidate)]))
          .digest("hex");
        if (score > best) {
          best = score;
          selected = candidate;
        }
      }
      return selected;
    }
    const next = this.cursors.get(scope) ?? 0;
    if (!this.cursors.has(scope) && this.cursors.size >= 4096)
      this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(scope, (next + 1) % candidates.length);
    return candidates[next % candidates.length];
  }
}
