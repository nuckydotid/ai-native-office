import type { ReactNode, SVGProps } from 'react';

/** A small set of line icons (24 px grid, drawn with the current text color). */
const make =
  (paths: ReactNode) =>
  ({ size = 18, ...props }: SVGProps<SVGSVGElement> & { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths}
    </svg>
  );

export const ServerIcon = make(
  <>
    <rect x="2.5" y="3" width="19" height="7.5" rx="2" />
    <rect x="2.5" y="13.5" width="19" height="7.5" rx="2" />
    <path d="M6.5 6.75h.01M6.5 17.25h.01M11 6.75h6M11 17.25h6" />
  </>,
);
export const DatabaseIcon = make(
  <>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    <path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </>,
);
export const BucketIcon = make(
  <>
    <rect x="3" y="3.5" width="18" height="5" rx="1.5" />
    <path d="M5 8.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
    <path d="M10 12.5h4" />
  </>,
);
export const ActivityIcon = make(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />);
export const ShieldIcon = make(
  <>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </>,
);
export const GlobeIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
  </>,
);
/** A sun (upper left) and a crescent moon (lower right) together: "follow the system" for the light/dark switch. */
export const SunMoonIcon = make(
  <>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1M1.5 8h1M3.4 3.4l.7.7M12.6 3.4l-.7.7M3.4 12.6l.7-.7" />
    <path d="M21.5 16.5A5.5 5.5 0 1 1 15.5 10.5 4.3 4.3 0 0 0 21.5 16.5z" />
  </>,
);
export const BranchIcon = make(
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7v10M18 10c0 5-8 3-12 7" />
  </>,
);
export const RocketIcon = make(
  <>
    <path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2-.1-2.8S5.8 14.3 5 15z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2z" />
    <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
  </>,
);
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const AlertIcon = make(
  <>
    <path d="M12 3.5l10 17.5H2z" />
    <path d="M12 10v4M12 17.5h.01" />
  </>,
);
export const CpuIcon = make(
  <>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </>,
);
export const LayersIcon = make(
  <>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" />
  </>,
);
export const CloudIcon = make(<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z" />);
export const KeyIcon = make(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M16 7l3 3" />
  </>,
);
export const BoxIcon = make(
  <>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5M12 13v8" />
  </>,
);
export const RefreshIcon = make(
  <>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </>,
);
export const ZapIcon = make(<path d="M13 2L3 14h8l-1 8 10-12h-8z" />);
export const CodeIcon = make(<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />);
export const MonitorIcon = make(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 21h8M12 16v5" />
  </>,
);
export const UserIcon = make(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
  </>,
);
