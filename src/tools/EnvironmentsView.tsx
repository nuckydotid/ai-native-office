import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, CardBody, Chip, Input, Select, SelectItem, Switch } from '@heroui/react';
import { splitOf } from '../pipeline/RolloutView.tsx';
import { pipelineApi } from '../pipeline/api.ts';
import { usePipeline } from '../pipeline/store.ts';
import { useOffice } from '../office/store.ts';
import { SCAN_SEVERITIES } from '../shared/pipeline/types.ts';
import type { Environment, Rollout } from '../shared/pipeline/types.ts';
import { teamOrigin } from '../team/connect.ts';
import { sentence } from '../team/rest.ts';
import { TrafficBar } from '../ui';
import { formFromPolicy, policyFromForm, samePolicy, type PolicyForm } from './policy-form.ts';

const SERVICE: Record<Environment, { name: string; line: string }> = {
  staging: { name: 'northwind-portal-staging', line: 'Takes all its traffic at once, then the smoke suite runs against it.' },
  production: { name: 'northwind-portal', line: 'Takes traffic in steps; every step is measured before the next.' },
};

/** The two Cloud Run services the sample app runs on, what they serve now, and the thresholds every gate reads. */
export function EnvironmentsView({ visible }: { visible: boolean }) {
  const info = usePipeline((s) => s.info);
  const rollouts = usePipeline((s) => s.rollouts);
  const connected = usePipeline((s) => s.connected);
  const role = useOffice((s) => s.role);
  const owner = role === 'owner' || role === 'admin';
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (visible) void usePipeline.getState().load();
  }, [visible]);
  // The form follows the server until the person starts typing.
  useEffect(() => {
    if (info && form === null) setForm(formFromPolicy(info.policy));
  }, [info, form]);

  const latest = useMemo(() => {
    const by = new Map<Environment, Rollout>();
    for (const r of [...rollouts].sort((a, b) => a.createdAt - b.createdAt)) by.set(r.service, r);
    return by;
  }, [rollouts]);

  const parsed = form ? policyFromForm(form) : null;
  const dirty = !!(info && parsed && !samePolicy(parsed, info.policy));
  const set = (patch: Partial<PolicyForm>) => {
    setMessage(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    setMessage(null);
    try {
      await pipelineApi.setPolicy(teamOrigin(), parsed);
      await usePipeline.getState().load();
      setMessage({ ok: true, text: 'Saved. Every gate reads these from now on.' });
    } catch (e) {
      setMessage({ ok: false, text: sentence(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`min-h-0 flex-1 overflow-y-auto p-4 ${visible ? '' : 'hidden'}`}>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-large font-semibold">Environments</h2>
          <p className="text-small text-foreground-500">Where the sample app runs, and the thresholds that decide whether a change may move on.</p>
        </div>

        {connected === false ? (
          <p className="rounded-medium bg-default-50 px-3 py-6 text-center text-small text-foreground-500">The delivery pipeline isn’t connected on this server, so there are no environments to show.</p>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2" aria-label="Services">
              {(['staging', 'production'] as const).map((env) => {
                const r = latest.get(env);
                return (
                  <Card key={env} shadow="md">
                    <CardBody className="gap-3 p-4">
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate font-mono text-small font-semibold">{SERVICE[env].name}</p>
                        <Chip size="sm" variant="flat" color={r?.state === 'complete' ? 'success' : r?.state === 'rolled_back' ? 'danger' : 'default'}>
                          {r ? r.state.replace('_', ' ') : 'baseline'}
                        </Chip>
                      </div>
                      <p className="text-tiny text-foreground-500">{SERVICE[env].line}</p>
                      {r ? <TrafficBar label={`${SERVICE[env].name} traffic`} segments={splitOf(r)} /> : <p className="text-small text-foreground-600">Serving the baseline revision. Nothing has been rolled out yet.</p>}
                    </CardBody>
                  </Card>
                );
              })}
            </section>

            <section className="flex flex-col gap-3" aria-label="Thresholds">
              <div>
                <h3 className="text-medium font-semibold">Thresholds</h3>
                <p className="text-small text-foreground-500">Rules decide whether a step is healthy; an AI colleague only writes it up. {owner ? '' : 'Only an owner or an admin changes them.'}</p>
              </div>
              {form === null ? null : (
                <Card shadow="md">
                  <CardBody className="gap-4 p-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Input size="sm" type="number" label="Least coverage (%)" value={form.coverageMin} onValueChange={(v) => set({ coverageMin: v })} isDisabled={!owner} />
                      <Input size="sm" type="number" label="Most errors (% of requests)" value={form.errorRatePct} onValueChange={(v) => set({ errorRatePct: v })} isDisabled={!owner} />
                      <Input size="sm" type="number" label="Slowest p95 (ms)" value={form.p95MsMax} onValueChange={(v) => set({ p95MsMax: v })} isDisabled={!owner} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Select size="sm" label="Worst scan finding allowed" disallowEmptySelection selectedKeys={[form.scanMaxSeverity]} onSelectionChange={(keys) => set({ scanMaxSeverity: Array.from(keys)[0] as PolicyForm['scanMaxSeverity'] })} isDisabled={!owner}>
                        {SCAN_SEVERITIES.map((s) => (
                          <SelectItem key={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>
                        ))}
                      </Select>
                      <Input size="sm" label="Traffic steps (%)" description="Ascending, ending at 100" value={form.rolloutPlan} onValueChange={(v) => set({ rolloutPlan: v })} isDisabled={!owner} />
                    </div>
                    <div className="flex flex-wrap gap-6">
                      <Switch size="sm" isSelected={form.scanRequired} onValueChange={(v) => set({ scanRequired: v })} isDisabled={!owner}>
                        A release needs a vulnerability scan
                      </Switch>
                      <Switch size="sm" isSelected={form.separationOfDuties} onValueChange={(v) => set({ separationOfDuties: v })} isDisabled={!owner}>
                        The author can’t approve their own release
                      </Switch>
                    </div>
                    {parsed === null && <Alert color="warning" variant="flat" hideIcon description="One of those values is empty or out of range. Nothing is saved until they are all valid." />}
                    {message && <Alert color={message.ok ? 'success' : 'danger'} variant="flat" hideIcon description={message.text} />}
                    <div className="flex items-center gap-2">
                      <Button color="primary" size="sm" isDisabled={!owner || !dirty} isLoading={saving} onPress={() => void save()}>
                        Save thresholds
                      </Button>
                      <Button size="sm" variant="flat" isDisabled={!info || !dirty} onPress={() => info && setForm(formFromPolicy(info.policy))}>
                        Undo changes
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
