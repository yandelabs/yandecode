import { describe, expect, it } from 'vitest';
import { fitRows } from '@cli/shared/budget';

describe('fitRows', () => {
  it('keeps everything that fits', () => {
    expect(fitRows('h', ['a', 'b'], 100)).toBe('h\na\nb');
  });

  it('drops whole trailing rows and reports how many', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `row ${i} ${'x'.repeat(20)}`);
    const text = fitRows('header', rows, 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toMatch(/… \d+ more row\(s\) omitted/);
    expect(
      text
        .split('\n')
        .slice(1, -1)
        .every((l) => l.startsWith('row ')),
    ).toBe(true);
  });

  it('cuts a single oversized first row instead of returning nothing', () => {
    const text = fitRows('h', ['y'.repeat(1000)], 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain('…[cut]');
  });
});
