import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, CheckboxGroup, Chip, Input, Tab, Tabs, Textarea } from '@heroui/react';
import { HeadAvatar, Save } from '../ui';
import { codePointLength } from '../shared/workspace/text.ts';
import { AppearanceEditor } from './AppearanceEditor.tsx';
import { AGENT_LIMITS, agentLook, agentProblems, sameAgent, skillsOf } from './format.ts';
import type { AgentFile, Listing } from './format.ts';

type TabId = 'profile' | 'skills' | 'looks';

/** The tab that holds the first problem. */
const tabFor = (problems: ReturnType<typeof agentProblems>): TabId =>
  problems.handle || problems.displayName || problems.role || problems.greeting || problems.persona ? 'profile' : problems.skills ? 'skills' : problems.look ? 'looks' : 'profile';

const count = (text: string, max: number) => `${codePointLength(text).toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;

/**
 * The form for one agent: who it is, what it knows (skills), and how it looks. It keeps what has been typed until Save; while
 * nothing has been typed it follows what the server has.
 */
export function AgentEditor({
  saved,
  listing,
  onDirty,
  onSave,
}: {
  saved: AgentFile;
  listing: Listing;
  onDirty: (dirty: boolean) => void;
  onSave: (agent: AgentFile) => Promise<void>;
}) {
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('profile');

  // Nothing typed yet: follow the files. Something typed: keep it.
  if (saved !== base) {
    setBase(saved);
    if (sameAgent(draft, base)) setDraft(saved);
  }

  const dirty = !sameAgent(draft, saved);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // The handle can't be changed, so there is no other handle to clash with.
  const problems = useMemo(() => agentProblems(draft, []), [draft]);
  const problemCount = Object.keys(problems).length;
  const set = (patch: Partial<AgentFile>) => setDraft((d) => ({ ...d, ...patch }));
  const { found, missing } = skillsOf(draft, listing);

  async function save() {
    setTried(true);
    if (problemCount > 0) {
      // Take the person to the first tab that has something to fix.
      setTab(tabFor(problems));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const show = (field: keyof typeof problems, typed: boolean) => (tried || typed ? problems[field] : undefined);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <HeadAvatar look={agentLook(draft)} name={draft.displayName || draft.handle} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-large font-semibold">{draft.displayName || draft.handle}</h2>
          <p className="truncate text-small text-foreground-500">@{draft.handle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" color="primary" startContent={<Save size={14} />} isLoading={saving} isDisabled={!dirty} onPress={() => void save()}>
            Save
          </Button>
        </div>
      </div>

      {error && <Alert color="danger" variant="flat" title="Couldn’t save the agent" description={error} />}
      {tried && problemCount > 0 && <Alert color="warning" variant="flat" title="A few things need another look" description="They’re marked below." />}

      <Tabs aria-label="Agent" size="sm" radius="lg" selectedKey={tab} onSelectionChange={(key) => setTab(key as TabId)}>
        <Tab key="profile" title="Profile">
          <div className="flex max-w-2xl flex-col gap-4 pt-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Name"
                variant="flat"
                value={draft.displayName}
                onValueChange={(displayName) => set({ displayName })}
                isInvalid={Boolean(show('displayName', draft.displayName.length > 0))}
                errorMessage={show('displayName', draft.displayName.length > 0)}
                isRequired
              />
              <Input
                label="Handle"
                variant="flat"
                startContent={<span className="text-foreground-400">@</span>}
                value={draft.handle}
                onValueChange={(value) => set({ handle: value.toLowerCase() })}
                isReadOnly
                isDisabled
                isInvalid={Boolean(show('handle', draft.handle.length > 0))}
                errorMessage={show('handle', draft.handle.length > 0)}
                description="It can’t be changed: people have already mentioned it."
                isRequired
              />
            </div>
            <Input
              label="Role"
              variant="flat"
              placeholder="What it does, like Code reviewer"
              value={draft.role}
              onValueChange={(role) => set({ role })}
              isInvalid={Boolean(show('role', true))}
              errorMessage={show('role', true)}
              description="One line, shown under its name in chat."
            />
            <Textarea
              label="Greeting"
              variant="flat"
              minRows={2}
              maxRows={4}
              placeholder="Hi! What can I help you with?"
              value={draft.greeting}
              onValueChange={(greeting) => set({ greeting })}
              isInvalid={Boolean(show('greeting', true))}
              errorMessage={show('greeting', true)}
              description={`What it says when someone only says hello. ${count(draft.greeting, AGENT_LIMITS.greeting)}`}
            />
            <Textarea
              label="Instructions"
              variant="flat"
              minRows={8}
              maxRows={22}
              value={draft.persona}
              onValueChange={(persona) => set({ persona })}
              isInvalid={Boolean(show('persona', true))}
              errorMessage={show('persona', true)}
              description={`Who it is, how it answers, what it never does. ${count(draft.persona, AGENT_LIMITS.persona)}`}
            />
          </div>
        </Tab>

        <Tab key="skills" title={draft.skills.length ? `Skills (${draft.skills.length})` : 'Skills'}>
          <div className="flex max-w-2xl flex-col gap-4 pt-2">
            <p className="text-small text-foreground-500">A skill is a way of doing something that an agent follows when it answers. Tick the ones this agent should use.</p>
            {show('skills', true) && <Alert color="danger" variant="flat" title={problems.skills} />}
            {listing.skills.length === 0 ? (
              <p className="text-small text-foreground-500">There are no skills in this project yet.</p>
            ) : (
              <CheckboxGroup
                aria-label="Skills this agent uses"
                value={found.map((s) => s.id)}
                onValueChange={(ids) => set({ skills: [...draft.skills.filter((id) => ids.includes(id) || !listing.skills.some((s) => s.id === id)), ...ids.filter((id) => !draft.skills.includes(id))] })}
                classNames={{ wrapper: 'gap-1' }}
              >
                {listing.skills.map((skill) => (
                  <div key={skill.id} className="flex items-start gap-2 rounded-medium bg-default-50 p-3">
                    <Checkbox value={skill.id} aria-label={skill.name} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-small font-medium">{skill.name}</p>
                      <p className="line-clamp-2 text-tiny text-foreground-500">{skill.description || 'No description.'}</p>
                    </div>
                  </div>
                ))}
              </CheckboxGroup>
            )}
            {missing.length > 0 && (
              <Alert
                color="warning"
                variant="flat"
                title={missing.length === 1 ? 'A skill this agent uses is missing' : 'Skills this agent uses are missing'}
                description="They may not be pulled yet, or were deleted. Pull the latest, or remove them here."
                endContent={
                  <div className="flex flex-wrap gap-1">
                    {missing.map((id) => (
                      <Chip key={id} size="sm" variant="flat" onClose={() => set({ skills: draft.skills.filter((s) => s !== id) })}>
                        {id}
                      </Chip>
                    ))}
                  </div>
                }
              />
            )}
          </div>
        </Tab>

        <Tab key="looks" title="Appearance">
          <div className="pt-2">
            {draft.look && (
              <AppearanceEditor look={draft.look} seed={`agent:${draft.handle}`} onChange={(look) => set({ look })} />
            )}
            {!draft.look && (
              <Button size="sm" variant="flat" onPress={() => set({ look: agentLook(draft) })}>
                Pick how it looks
              </Button>
            )}
          </div>
        </Tab>
      </Tabs>
    </div>
  );
}
