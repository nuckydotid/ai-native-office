import { Card, CardBody, Chip } from '@heroui/react';
import { usePipeline } from '../pipeline/store.ts';
import { IconBubble } from '../ui';
import { Cloud, Plug } from '../ui/lucide';
import { integrationsFor, STATUS_COLOR, STATUS_LABEL } from './integrations.ts';

/**
 * The services behind the pipeline, with what is true of each right now. Google services are listed with how far they are
 * connected; partner tools that need a key or a repository say so instead of pretending.
 */
export function IntegrationsView({ visible }: { visible: boolean }) {
  const info = usePipeline((s) => s.info);
  const connected = usePipeline((s) => s.connected);
  const list = integrationsFor(connected && info ? { driver: info.driver } : null);
  const groups = [
    { id: 'google', title: 'Google Cloud', icon: <Cloud size={18} /> },
    { id: 'partner', title: 'Partner AI tools', icon: <Plug size={18} /> },
  ] as const;
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto p-4 ${visible ? '' : 'hidden'}`}>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-large font-semibold">Integrations</h2>
          <p className="text-small text-foreground-500">What the pipeline runs on, and how far each service is connected on this server.</p>
        </div>
        {groups.map((g) => (
          <section key={g.id} className="flex flex-col gap-2" aria-label={g.title}>
            <h3 className="flex items-center gap-2 text-medium font-semibold">
              <IconBubble color="primary" size="sm">
                {g.icon}
              </IconBubble>
              {g.title}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {list
                .filter((i) => i.group === g.id)
                .map((i) => (
                  <Card key={i.id} shadow="md">
                    <CardBody className="gap-2 p-4">
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 text-small font-semibold leading-5">{i.name}</p>
                        <Chip size="sm" variant="flat" color={STATUS_COLOR[i.status]}>
                          {STATUS_LABEL[i.status]}
                        </Chip>
                      </div>
                      <p className="text-small text-foreground-600">{i.does}</p>
                      <p className="text-tiny text-foreground-500">{i.detail}</p>
                    </CardBody>
                  </Card>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
