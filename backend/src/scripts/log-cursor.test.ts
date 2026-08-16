import { describe, expect, it } from 'vitest';
import { alignToLineStart } from './log-cursor.js';

describe('alignToLineStart', () => {
  it('returns offset 0 unchanged when the cursor is already at the start', () => {
    expect(alignToLineStart(Buffer.from('line one\nline two\n'), 0)).toBe(0);
  });

  it('aligns a mid-line offset to the next newline in the middle of the buffer', () => {
    expect(alignToLineStart(Buffer.from('line one\nline two\n'), 3)).toBe(9);
  });

  it('aligns an offset pointing at a newline to the start of the following line', () => {
    expect(alignToLineStart(Buffer.from('line one\nline two\n'), 8)).toBe(9);
  });

  it('returns the buffer length when the offset is past the last newline', () => {
    expect(alignToLineStart(Buffer.from('line one\nno newline'), 9)).toBe(19);
  });

  it('clamps offsets beyond the buffer length to the buffer length', () => {
    const buffer = Buffer.from('line one\n');
    expect(alignToLineStart(buffer, 10)).toBe(9);
    expect(alignToLineStart(buffer, 50)).toBe(9);
  });
});