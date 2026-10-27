import { describe, expect, it } from 'vitest';
import { generatePassword, passwordStrength } from './password';

describe('passwordStrength', () => {
  it('rates short passwords as too short', () => {
    expect(passwordStrength('abc')).toBe(0);
  });

  it('marks common words and personal details as weak', () => {
    expect(passwordStrength('MyPassword!2026')).toBe(1);
    expect(passwordStrength('alex-2026-Rocks', ['alex'])).toBe(1);
  });

  it('penalises keyboard runs', () => {
    expect(passwordStrength('Abcd#efgH9xp')).toBeLessThan(passwordStrength('Kq7v#z3mW9xp'));
  });

  it('rates long, varied passwords as strong', () => {
    expect(passwordStrength('t7#Rv!q2Lm9@xPz4Wk&e')).toBe(4);
  });
});

describe('generatePassword', () => {
  it('creates strong passwords of the requested length', () => {
    const value = generatePassword(24);
    expect(value).toHaveLength(24);
    expect(passwordStrength(value)).toBeGreaterThanOrEqual(3);
  });
});
