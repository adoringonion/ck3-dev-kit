import { Position, Range } from "./types";

export class TextCursor {
  private readonly lineOffsets: number[];

  constructor(readonly text: string) {
    this.lineOffsets = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") {
        this.lineOffsets.push(index + 1);
      }
    }
  }

  positionAt(offset: number): Position {
    const bounded = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineOffsets.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const current = this.lineOffsets[mid];
      const next = mid + 1 < this.lineOffsets.length ? this.lineOffsets[mid + 1] : this.text.length + 1;
      if (bounded < current) {
        high = mid - 1;
      } else if (bounded >= next) {
        low = mid + 1;
      } else {
        return { line: mid, character: bounded - current, offset: bounded };
      }
    }

    return { line: 0, character: bounded, offset: bounded };
  }

  range(start: number, end: number): Range {
    return {
      start: this.positionAt(start),
      end: this.positionAt(end),
    };
  }
}
