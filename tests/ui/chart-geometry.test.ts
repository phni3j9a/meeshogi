import { describe, expect, it } from 'vitest';
import { chartIndexAtX, chartPlyTicks } from '../../src/ui/chart-geometry';

describe('evaluation chart navigation', () => {
  it('maps taps and drags to the same positions, including the terminal position', () => {
    expect(chartIndexAtX(5, 5, 320, 81)).toBe(0);
    expect(chartIndexAtX(181, 5, 320, 81)).toBe(44);
    expect(chartIndexAtX(325, 5, 320, 81)).toBe(80);
    expect(chartIndexAtX(-100, 5, 320, 81)).toBe(0);
    expect(chartIndexAtX(800, 5, 320, 81)).toBe(80);
  });
  it('handles an initial position and rejects absent or unmeasured data', () => {
    expect(chartIndexAtX(120, 5, 320, 1)).toBe(0);
    expect(chartIndexAtX(120, 5, 320, 0)).toBeNull();
    expect(chartIndexAtX(120, 5, 0, 81)).toBeNull();
    expect(chartIndexAtX(NaN, 5, 320, 81)).toBeNull();
  });
  it('uses round move intervals and leaves space for the final move', () => {
    expect(chartPlyTicks(80)).toEqual([0, 20, 40, 60, 80]);
    expect(chartPlyTicks(81)).toEqual([0, 20, 40, 60, 81]);
    expect(chartPlyTicks(121)).toEqual([0, 30, 60, 90, 121]);
    expect(chartPlyTicks(0)).toEqual([0]);
    expect(chartPlyTicks(1)).toEqual([0, 1]);
    expect(chartPlyTicks(400)).toEqual([0, 100, 200, 300, 400]);
  });
});
