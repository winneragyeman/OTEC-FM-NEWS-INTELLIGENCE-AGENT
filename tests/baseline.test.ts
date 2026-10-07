import { describe, it, expect } from 'vitest';
import { computeScoreFromComponents } from '../server/services/baseline.service.ts';

describe('Baseline Ranking Heuristic', () => {
  it('computes baseline score for a cluster with 1 article, 24 hours old, 1 outlet, velocity 0', () => {
    // Expected score ≈ 0.40 * exp(-0.08 * 24) + 0.35 * (ln(2)/ln(5)) + 0.25 * 0
    //                ≈ 0.2094 (allow ±0.01 tolerance)
    const result = computeScoreFromComponents(24, 0, 1);
    expect(result.score).toBeGreaterThanOrEqual(0.1994);
    expect(result.score).toBeLessThanOrEqual(0.2194);
    expect(result.score).toBeCloseTo(0.2094, 2);
    expect(result.components.age_hours).toBe(24);
    expect(result.components.velocity).toBe(0);
    expect(result.components.outlet_count).toBe(1);
  });

  it('computes baseline score for a cluster with 4 articles, all fresh (<1 hour), 4 outlets, velocity 4', () => {
    // Expected score ≈ 0.40 * 1.0 + 0.35 * 1.0 + 0.25 * 1.0 = 1.0 (capped)
    const result = computeScoreFromComponents(0, 4, 4);
    expect(result.score).toBe(1.0);
    expect(result.components.recency_norm).toBe(1.0);
    expect(result.components.outlet_norm).toBe(1.0);
    expect(result.components.velocity_norm).toBe(1.0);
  });

  it('outlet_norm for outlet_count = 4 must equal exactly 1.0', () => {
    // outlet_norm = Math.log(1 + 4) / Math.log(5) = ln(5)/ln(5) = 1.0
    const result = computeScoreFromComponents(12, 1, 4);
    expect(result.components.outlet_norm).toBe(1.0);
  });
});
