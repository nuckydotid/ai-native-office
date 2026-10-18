import { heroui } from '@heroui/react';

// The one place where the app's look is decided. Components never use literal colors, sizes or shadows: they use the
// tokens this file defines (see AGENTS.md). Surfaces are separated by soft shadows and by fill, not by borders.

const light = {
  small: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
  medium: '0 2px 4px -1px rgb(15 23 42 / 0.04), 0 8px 24px -6px rgb(15 23 42 / 0.12)',
  large: '0 4px 8px -2px rgb(15 23 42 / 0.05), 0 24px 56px -12px rgb(15 23 42 / 0.22)',
};

// On dark backgrounds a shadow alone barely shows, so each also carries a faint light edge along the top.
const dark = {
  small: '0 1px 2px 0 rgb(0 0 0 / 0.5), inset 0 1px 0 0 rgb(255 255 255 / 0.04)',
  medium: '0 8px 24px -6px rgb(0 0 0 / 0.6), inset 0 1px 0 0 rgb(255 255 255 / 0.05)',
  large: '0 24px 56px -12px rgb(0 0 0 / 0.75), inset 0 1px 0 0 rgb(255 255 255 / 0.07)',
};

export default heroui({
  layout: {
    radius: { small: '8px', medium: '12px', large: '16px' },
  },
  themes: {
    light: {
      layout: { boxShadow: light },
      colors: {
        background: '#f4f5f9',
        content1: { DEFAULT: '#ffffff', foreground: '#11181c' },
        content2: { DEFAULT: '#f1f2f7', foreground: '#11181c' },
        divider: 'rgba(15, 23, 42, 0.07)',
      },
    },
    dark: {
      layout: { boxShadow: dark },
      colors: {
        background: '#0b0c10',
        content1: { DEFAULT: '#15171d', foreground: '#ecedee' },
        content2: { DEFAULT: '#1c1f27', foreground: '#ecedee' },
        divider: 'rgba(255, 255, 255, 0.08)',
      },
    },
  },
});
