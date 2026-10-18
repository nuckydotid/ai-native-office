#!/usr/bin/env node
// Reads the reporters' files and prints the one line the pipeline service parses. No dependencies.
import { readFileSync } from 'node:fs';

const [kind = 'all'] = process.argv.slice(2);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function unitResult() {
  const report = readJson('test-results/unit.json');
  if (!report) return { ok: false, passed: 0, failed: 1, skipped: 0, durationMs: 0 };
  const durationMs = report.testResults?.reduce((sum, suite) => sum + Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0)), 0) ?? 0;
  return { ok: (report.numFailedTests ?? 0) === 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0, skipped: report.numPendingTests ?? 0, durationMs };
}

function e2eResult() {
  const stats = readJson('test-results/e2e.json')?.stats;
  if (!stats) return { ok: false, passed: 0, failed: 1, skipped: 0, durationMs: 0 };
  return { ok: (stats.unexpected ?? 0) === 0, passed: stats.expected ?? 0, failed: stats.unexpected ?? 0, skipped: stats.skipped ?? 0, durationMs: stats.duration ?? 0 };
}

const parts = [];
if (kind === 'unit' || kind === 'all') parts.push(unitResult());
if (kind === 'e2e' || kind === 'all') parts.push(e2eResult());
if (parts.length === 0) parts.push({ ok: true, passed: 0, failed: 0, skipped: 0, durationMs: 0 });

const merged = {
  ok: parts.every((p) => p.ok),
  kind,
  passed: parts.reduce((n, p) => n + p.passed, 0),
  failed: parts.reduce((n, p) => n + p.failed, 0),
  skipped: parts.reduce((n, p) => n + p.skipped, 0),
  durationMs: parts.reduce((n, p) => n + p.durationMs, 0),
};
const coverage = readJson('coverage/coverage-summary.json');
if (coverage?.total?.lines?.pct !== undefined) merged.coveragePct = Math.round(coverage.total.lines.pct * 10) / 10;
if (!merged.ok) process.exitCode = 1;

process.stdout.write(`PIPELINE_RESULT: ${JSON.stringify(merged)}\n`);
