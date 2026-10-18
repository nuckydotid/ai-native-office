import { Button, Card, CardBody, Select, SelectItem } from '@heroui/react';
import { ColorSwatches, Shuffle } from '../ui';
import { figureUrl } from '../pixel/avatar.ts';
import { HAIR_COLORS, OUTFIT_COLORS, PANTS_COLORS, SKIN_TONES, lookFromSeed } from '../shared/workspace/looks.ts';
import { ACCESSORY_NAMES, HAIR_STYLE_NAMES, OUTFIT_STYLE_NAMES, PANTS_STYLE_NAMES } from '../shared/workspace/types.ts';
import type { Appearance, Dir } from '../shared/workspace/types.ts';

const VIEWS: { dir: Dir; label: string }[] = [
  { dir: 'down', label: 'Front' },
  { dir: 'left', label: 'Left' },
  { dir: 'right', label: 'Right' },
  { dir: 'up', label: 'Back' },
];

function Choice({ label, names, value, onChange }: { label: string; names: readonly string[]; value: number; onChange: (index: number) => void }) {
  return (
    <Select
      label={label}
      size="sm"
      variant="flat"
      disallowEmptySelection
      selectedKeys={[String(Math.min(Math.max(value, 0), names.length - 1))]}
      onSelectionChange={(keys) => {
        const next = Number(Array.from(keys)[0]);
        if (Number.isInteger(next)) onChange(next);
      }}
    >
      {names.map((name, i) => (
        <SelectItem key={String(i)}>{name}</SelectItem>
      ))}
    </Select>
  );
}

function Swatches({ label, colors, value, onChange }: { label: string; colors: readonly string[]; value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-small text-foreground-500">{label}</span>
      <ColorSwatches label={label} colors={colors} value={value} onValueChange={onChange} size="sm" />
    </div>
  );
}

/**
 * How an agent looks: the same pixel character the office draws, shown from four sides, with the choices that make it up. Every
 * change is live in the preview; nothing is saved until the agent is.
 */
export function AppearanceEditor({ look, seed, onChange }: { look: Appearance; seed: string; onChange: (look: Appearance) => void }) {
  const set = (patch: Partial<Appearance>) => onChange({ ...look, ...patch });
  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <Card shadow="none" className="shrink-0 self-start bg-default-100">
        <CardBody className="gap-3">
          <div className="flex items-end justify-center gap-3">
            {VIEWS.map((v) => (
              <figure key={v.dir} className="flex flex-col items-center gap-1">
                <img src={figureUrl(look, v.dir, 4)} alt={`${v.label} view`} width={64} height={112} className="wts-pixel" />
                <figcaption className="text-tiny text-foreground-500">{v.label}</figcaption>
              </figure>
            ))}
          </div>
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="flat" startContent={<Shuffle size={14} />} onPress={() => onChange(lookFromSeed(String(Math.random())))}>
              Randomise
            </Button>
            <Button size="sm" variant="light" onPress={() => onChange(lookFromSeed(seed))}>
              Start over
            </Button>
          </div>
        </CardBody>
      </Card>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Choice label="Hair" names={HAIR_STYLE_NAMES} value={look.hairStyle} onChange={(hairStyle) => set({ hairStyle })} />
          <Choice label="Accessory" names={ACCESSORY_NAMES} value={look.accessory} onChange={(accessory) => set({ accessory })} />
          <Choice label="Top" names={OUTFIT_STYLE_NAMES} value={look.outfitStyle ?? 0} onChange={(outfitStyle) => set({ outfitStyle })} />
          <Choice label="Trousers" names={PANTS_STYLE_NAMES} value={look.pantsStyle ?? 0} onChange={(pantsStyle) => set({ pantsStyle })} />
        </div>
        <Swatches label="Skin" colors={SKIN_TONES} value={look.skin} onChange={(skin) => set({ skin })} />
        <Swatches label="Hair color" colors={HAIR_COLORS} value={look.hair} onChange={(hair) => set({ hair })} />
        <Swatches label="Top color" colors={OUTFIT_COLORS} value={look.outfit} onChange={(outfit) => set({ outfit })} />
        <Swatches label="Trousers color" colors={PANTS_COLORS} value={look.pants} onChange={(pants) => set({ pants })} />
      </div>
    </div>
  );
}
