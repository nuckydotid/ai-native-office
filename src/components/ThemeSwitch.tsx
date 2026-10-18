import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import type { ReactNode } from 'react';
import { useThemeMode, type ThemeMode } from '../theme';
import { SunMoonIcon } from '../ui';

const icon = (path: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const ICONS: Record<ThemeMode, ReactNode> = {
  system: <SunMoonIcon size={18} />,
  light: icon(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
  ),
  dark: icon(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />),
};

const LABELS: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeSwitch() {
  const { mode, setMode } = useThemeMode();

  return (
    <Dropdown placement="bottom-end">
      <DropdownTrigger>
        <Button isIconOnly variant="light" aria-label={`Theme: ${LABELS[mode]}`}>
          {ICONS[mode]}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="Theme mode"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={new Set([mode])}
        onSelectionChange={(keys) => {
          const next = Array.from(keys)[0] as ThemeMode | undefined;
          if (next) setMode(next);
        }}
      >
        {(Object.keys(LABELS) as ThemeMode[]).map((key) => (
          <DropdownItem key={key} startContent={ICONS[key]}>
            {LABELS[key]}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}
