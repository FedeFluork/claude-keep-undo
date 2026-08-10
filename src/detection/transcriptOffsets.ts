/**
 * Where to start reading each Claude Code session transcript.
 *
 * Kept free of any `vscode` or `fs` import so it can be unit tested: the rule it
 * encodes is subtle and getting it wrong is silent. There are exactly two cases:
 *
 *  - **Transcripts that already existed when we started** are history. Attaching
 *    at their end is what stops a resumed session from replaying its whole
 *    conversation into the review queue.
 *  - **Transcripts that appear afterwards** belong to a session that started
 *    after us, so they are read from byte 0.
 *
 * The distinction is drawn by the *first sweep*, not by the first sweep that
 * happened to find something. That is the bug this class exists to prevent: when
 * the project has never run Claude Code the session directory does not exist
 * yet, so every early sweep comes back empty — and if an empty sweep does not
 * count as the first one, the transcript of the session the user is about to
 * start gets classified as history and skipped entirely.
 */
export class TranscriptOffsets {
  private swept = false;
  private readonly offsets = new Map<string, number>();

  /**
   * Register the transcripts visible right now, assigning a starting offset to
   * any that is new. Files already known keep the offset they have.
   *
   * Must be called on **every** sweep, including one that found nothing — an
   * empty sweep still establishes "this is what existed before us".
   */
  sync(files: readonly string[], sizeOf: (file: string) => number): void {
    for (const file of files) {
      if (!this.offsets.has(file)) {
        this.offsets.set(file, this.swept ? 0 : sizeOf(file));
      }
    }
    this.swept = true;
  }

  get(file: string): number {
    return this.offsets.get(file) ?? 0;
  }

  /**
   * Whether this file already has an offset.
   *
   * Lets a caller tell "attached just now" from "followed for a while", which is
   * what decides whether the next read may begin inside a line.
   */
  has(file: string): boolean {
    return this.offsets.has(file);
  }

  set(file: string, offset: number): void {
    this.offsets.set(file, offset);
  }

  /** True once the first sweep has run, whatever it found. */
  get attached(): boolean {
    return this.swept;
  }

  /** How many transcripts are being followed. */
  get size(): number {
    return this.offsets.size;
  }
}
