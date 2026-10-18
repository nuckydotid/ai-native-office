// The thresholds form on the Environments page, pure and unit-tested: policy to the strings a person edits, and back through the
// shared `parsePolicy`, the same check the web service applies, so a value the form accepts is a value the server accepts.

import { parsePolicy } from '../shared/pipeline/protocol.ts';
import type { PipelinePolicy, ScanSeverity } from '../shared/pipeline/types.ts';

export interface PolicyForm {
  coverageMin: string;
  /** In percent (1 means 1% of requests), as people read it. */
  errorRatePct: string;
  p95MsMax: string;
  scanMaxSeverity: ScanSeverity;
  scanRequired: boolean;
  separationOfDuties: boolean;
  /** "10, 50, 100". */
  rolloutPlan: string;
}

export const formFromPolicy = (p: PipelinePolicy): PolicyForm => ({
  coverageMin: String(p.coverageMin),
  errorRatePct: String(Number((p.errorRateMax * 100).toFixed(2))),
  p95MsMax: String(p.p95MsMax),
  scanMaxSeverity: p.scanMaxSeverity,
  scanRequired: p.scanRequired,
  separationOfDuties: p.separationOfDuties,
  rolloutPlan: p.rolloutPlan.join(', '),
});

const num = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s));

/** The policy the form describes, or `null` when any field is empty or out of range (nothing is repaired). */
export function policyFromForm(f: PolicyForm): PipelinePolicy | null {
  const plan = f.rolloutPlan.split(/[\s,]+/).filter(Boolean).map(Number);
  return parsePolicy({
    coverageMin: num(f.coverageMin),
    errorRateMax: num(f.errorRatePct) / 100,
    p95MsMax: num(f.p95MsMax),
    scanMaxSeverity: f.scanMaxSeverity,
    scanRequired: f.scanRequired,
    separationOfDuties: f.separationOfDuties,
    rolloutPlan: plan,
  });
}

export const samePolicy = (a: PipelinePolicy, b: PipelinePolicy): boolean => JSON.stringify(a) === JSON.stringify(b);
