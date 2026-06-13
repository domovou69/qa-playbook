/**
 * Utility functions for improved scanning logic.
 */

import * as crypto from 'node:crypto';

export function levenshteinDistance(a: string, b: string): number {
  const matrix: (number)[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const curr = matrix[i]!;
      const prev = matrix[i - 1]!;
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        curr[j] = prev[j - 1]!;
      } else {
        curr[j] = Math.min(prev[j - 1]! + 1, curr[j - 1]! + 1, prev[j]! + 1);
      }
    }
  }
  return matrix[b.length]![a.length]!;
}

export function hashString(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

export function jaccardSimilarityWithPrecondition(
  setA: Set<string>,
  setB: Set<string>,
  preconditionsMatch: boolean,
): { similarity: number; confidence: number } {
  if (setA.size === 0 && setB.size === 0) return { similarity: 1, confidence: 100 };
  if (setA.size === 0 || setB.size === 0) return { similarity: 0, confidence: 0 };
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection++;
  const similarity = intersection / (setA.size + setB.size - intersection);
  const baseConfidence = similarity * 100;
  const confidence = preconditionsMatch ? Math.min(100, baseConfidence * 1.1) : baseConfidence * 0.85;
  return { similarity, confidence };
}
