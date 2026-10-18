import { useState, type ReactNode } from 'react';
import { addToast, Button, Card, CardBody, CardFooter, CardHeader } from '@heroui/react';
import { useOffice } from '../office/store.ts';
import { useChatBridge } from '../sync/chat.ts';
import { Check, IconBubble, IconButton, Play, Route, Send, X } from '../ui';
import { runSampleStandup } from './actions.ts';
import { GUIDE_STEPS, SAMPLE_QUESTIONS } from './guide.ts';
import { useDemo } from './store.ts';

const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <li className="flex gap-3">
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-tiny font-semibold text-primary" aria-hidden>
      {n}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <p className="text-small font-medium">{title}</p>
      {children}
    </div>
  </li>
);

/**
 * "Judge's 3-minute path": a card that walks a first-time visitor through the three things the demo is for, with one click each.
 * It is floating and can be dismissed (the strip at the top brings it back). It acts through the Office's chat, never inside it.
 */
export function JudgePath() {
  const open = useDemo((s) => s.guideOpen);
  const close = useDemo((s) => s.closeGuide);
  const status = useDemo((s) => s.status);
  const send = useChatBridge((s) => s.send);
  const online = useOffice((s) => s.status.state === 'online');
  const [asked, setAsked] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  if (!open) return null;
  const ready = online && !!send;

  const ask = async (label: string, text: string) => {
    const result = await send?.(text);
    if (!result || !result.ok) {
      addToast({ title: 'Couldn’t send that', description: result?.message ?? 'The office isn’t open yet.', color: 'danger' });
      return;
    }
    setAsked((all) => (all.includes(label) ? all : [...all, label]));
  };

  const standup = async () => {
    setStarting(true);
    const result = await runSampleStandup(useOffice.getState().roomId);
    setStarting(false);
    if (!result.ok) return void addToast({ title: 'Couldn’t start the standup', description: result.message, color: 'danger' });
    setStarted(true);
    addToast({ title: 'The standup is starting', description: 'Watch the chat. When it ends, open the ⋯ menu above it and choose End meeting.', color: 'success', timeout: 6000 });
  };

  return (
    <Card shadow="lg" className="fixed inset-x-3 bottom-3 z-30 max-h-[70vh] sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-96" role="complementary" aria-label="Judge’s 3-minute path">
      <CardHeader className="items-start gap-3 pb-1">
        <IconBubble color="primary" size="md">
          <Route size={18} />
        </IconBubble>
        <div className="min-w-0 flex-1">
          <p className="text-medium font-semibold">Judge’s 3-minute path</p>
          <p className="text-tiny text-foreground-500">A live workspace for a made-up team. Three clicks show what the AI does here.</p>
        </div>
        <IconButton label="Close the guide" onPress={close}>
          <X size={16} />
        </IconButton>
      </CardHeader>
      <CardBody className="gap-4 overflow-y-auto pt-2">
        <ol className="flex flex-col gap-4">
          <Step n={1} title={GUIDE_STEPS[0].title}>
            <p className="text-tiny text-foreground-500">{GUIDE_STEPS[0].body}</p>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_QUESTIONS.map((q) => (
                <Button
                  key={q.label}
                  size="sm"
                  variant="flat"
                  color={asked.includes(q.label) ? 'success' : 'primary'}
                  isDisabled={!ready}
                  startContent={asked.includes(q.label) ? <Check size={14} /> : <Send size={14} />}
                  onPress={() => void ask(q.label, q.text)}
                  aria-label={`Ask: ${q.text}`}
                >
                  {q.label}
                </Button>
              ))}
            </div>
          </Step>
          <Step n={2} title={GUIDE_STEPS[1].title}>
            <p className="text-tiny text-foreground-500">{GUIDE_STEPS[1].body}</p>
            <div>
              <Button size="sm" variant="flat" color={started ? 'success' : 'primary'} isLoading={starting} isDisabled={!ready} startContent={started ? <Check size={14} /> : <Play size={14} />} onPress={() => void standup()}>
                Run sample standup
              </Button>
            </div>
          </Step>
          <Step n={3} title={GUIDE_STEPS[2].title}>
            <p className="text-tiny text-foreground-500">{GUIDE_STEPS[2].body}</p>
          </Step>
        </ol>
        <p className="rounded-medium bg-default-100/60 px-3 py-2 text-tiny text-foreground-500">
          Limits: the data is synthetic and the workspace resets nightly. {status ? `You have ${status.runsLeft} of ${status.runsPerHour} AI runs left this hour.` : 'AI runs are limited per visitor.'} An answer takes 10 to 30 seconds.
        </p>
      </CardBody>
      <CardFooter className="justify-end pt-0">
        <Button size="sm" color="primary" onPress={close}>
          Got it, let me look around
        </Button>
      </CardFooter>
    </Card>
  );
}
