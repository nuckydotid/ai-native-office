import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY } from '../shared/pipeline/types.ts';
import { formFromPolicy, policyFromForm, samePolicy } from './policy-form.ts';

test('the default policy goes into the form and comes back unchanged', () => {
  const form = formFromPolicy(DEFAULT_POLICY);
  assert.equal(form.errorRatePct, '1');
  assert.equal(form.rolloutPlan, '10, 50, 100');
  const back = policyFromForm(form);
  assert.ok(back && samePolicy(back, DEFAULT_POLICY));
});

test('a value out of range, empty or not a number refuses the whole form', () => {
  const ok = formFromPolicy(DEFAULT_POLICY);
  assert.equal(policyFromForm({ ...ok, coverageMin: '120' }), null);
  assert.equal(policyFromForm({ ...ok, coverageMin: '' }), null, 'empty is not zero');
  assert.equal(policyFromForm({ ...ok, p95MsMax: 'fast' }), null);
  assert.equal(policyFromForm({ ...ok, errorRatePct: '150' }), null);
  assert.equal(policyFromForm({ ...ok, rolloutPlan: '10, 50' }), null, 'a rollout must end at 100%');
  assert.equal(policyFromForm({ ...ok, rolloutPlan: '50, 10, 100' }), null, 'steps only go up');
});

test('the rollout steps may be separated by commas or spaces', () => {
  const p = policyFromForm({ ...formFromPolicy(DEFAULT_POLICY), rolloutPlan: '5 25 100' });
  assert.deepEqual(p?.rolloutPlan, [5, 25, 100]);
});

test('percent in the form is a fraction in the policy', () => {
  const p = policyFromForm({ ...formFromPolicy(DEFAULT_POLICY), errorRatePct: '2.5' });
  assert.equal(p?.errorRateMax, 0.025);
});
