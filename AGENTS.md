# Worktrees Studio: rules for agents and developers

The AI-native office: a React 19 web app (Vite) served by a Bun web service (`team-server/`) that runs on Google Cloud next to a
private Python agent service (`agent-service/`). Built for the Google Cloud AI Builder Cup 2026. The repository used to be a
desktop app as well (Tauri, Rust); that code is gone, and nothing here depends on a Mac.

Stack: React 19, **HeroUI 2.8** (the design system), Tailwind 4, PixiJS 8 (the office picture), zustand. Server: Bun, Hono,
WebSockets. Agents: Python, ADK 2.x, Gemini on Google Cloud's Gemini Enterprise Agent Platform.

## 0. Priority: AI colleagues that propose, and people who decide

- **The AI is a team of colleagues that live in the office and run on the server.** Gemini on the Agent Platform, driven by
  agents built with ADK 2.x in `agent-service/` (Cloud Run, private). The browser never holds a model, a key or a service
  account: a person asks in a room, the web service checks who may ask and calls the agent service with a Google-signed
  identity, and the answer arrives as a chat message. Never build a feature on a Gemini API key (the agent service calls the Agent
  Platform with its own service account, so no key exists to leak), on the Workspace API entitlement, on the Workspace MCP
  servers or on NotebookLM (no API).
- **AI gives people knowledge and proposals; people decide.** An agent reads the team's docs, tickets and past meetings, answers
  with citations, and posts a proposal card (tickets to create, minutes to save, a plan, a review) that a person accepts. It never
  creates, moves or saves anything itself. Three outcomes matter, in this order: **knowledge access** (cited, verified answers),
  **meetings to decisions to work** (minutes, risks and proposed tickets) and **workflow execution** (plans and reviews).
- **Agents are named for their job, not for a person**: Studio Agent, Librarian Agent, Scribe Agent, Planner Agent (handle
  `planner`), Reviewer Agent, Importer Agent.

## 1. Structure

- `src/` is the web app. `main.tsx` mounts `App.tsx`, which signs the visitor in as a guest (`auth.ts`, `web.ts`) and opens the one
  workspace in `components/ProjectShell.tsx`: the sidebar (Plan, In Progress, In Review, Settings with Docs and Agents), the
  ticket panel beside the office on the three ticket pages, and the demo's strip and guide (`demo/`).
- `src/office`: the virtual office. `OfficeView` is the entry, `session.ts` is one visit, `store.ts` the one zustand store,
  `net/` the WebSocket connection (`RemoteRoom`) and `LocalRoom`, an in-memory room the tests use, `world/` the Pixi picture,
  `core/` pure TypeScript with tests, `cast.ts` the agents as characters that walk to the room they work in.
- `src/board` (Plan, In Progress, In Review), `src/docs` (a tree of Markdown pages), `src/agents` (the Agents page): each reads and
  writes the web service over REST (`src/team/rest.ts`) and keeps its model in `src/shared`.
- `src/shared`: the contract between the app and the web service (workspace, board, pages, ai). It is the source;
  `npm run sync-core` copies it to `team-server/src/shared` and prunes stale copies. Never edit the copy; `npm run check` fails when it is
  out of date.
- `src/ai/cloud.ts` starts the agents for a visit: it sends `agent.start` and then only watches, because the server runs them.
- `src/components`, `src/ui`: screen parts, and building blocks that are not tied to one screen (section 3). Anything used in
  two places moves to `src/ui`.
- `team-server/`: the web service (Hono, Bun WebSockets, Postgres or in-memory). `agent-service/`: the agents and their evaluation.
  `deploy/`: Cloud Run setup and deploy scripts. `docs/demo-data/`: the synthetic workspace the demo is seeded from.

## 2. The design system is HeroUI

HeroUI is the only component library. **Before writing any UI, find the HeroUI component for it and use it.** A hand-built
version needs a reason that is written down (section 3).

| You need | Use |
| --- | --- |
| Action, icon action | `Button` (`isIconOnly` + `aria-label` for icons) |
| Text link, or a small text action | `Link` (web addresses open through `openExternal`); `ui/TextButton` for a text action |
| Text, number, password field | `Input` (`label`, `description`, `isInvalid` + `errorMessage`) |
| Pick one of a list | `Select` / `SelectItem` |
| On/off | `Switch`; ticking a box: `Checkbox` |
| Switch between views or ranges | `Tabs` / `Tab` |
| A menu or a sidebar list | `Listbox` / `ListboxItem`, `Dropdown` |
| A block of content | `Card` (`shadow="md"`) / `CardHeader` / `CardBody` |
| A message (error, warning, note, success) | `Alert` (`color` danger / warning / success / primary, `variant="flat"`, `title`, `description`) |
| A hint on hover | `Tooltip` (wrap a disabled button in a `span`) |
| Waiting for content | `Skeleton`; waiting for an action: `Spinner` or `isLoading`; progress: `Progress` |
| A label, status or count | `Chip` |
| Code, a value to copy | `Code`, `Snippet` |
| A dialog, a popover | `Modal`, `Popover` |
| Top bar | `Navbar` |

Check `@heroui/react`'s exports before deciding something is missing. HeroUI changes: look at the installed version's
types (`node_modules/@heroui/*/dist/*.d.ts`), not memory.

### Always use tokens, never literals

- **Colors:** theme names only: `primary`, `secondary`, `success`, `warning`, `danger`, `default`, `foreground`,
  `content1..4`, `divider` (with shades and opacity, such as `bg-primary/15`, `text-foreground-500`). No hex, `rgb()`,
  or Tailwind palette colors (`bg-blue-500`). In SVG use the theme variables (`hsl(var(--heroui-primary))`).
- **Text size:** `text-tiny`, `text-small`, `text-medium`, `text-large`; bigger headings may use Tailwind's `text-xl` and up.
- **Radius and shadow:** `rounded-small / medium / large`, `shadow-small / medium / large`.
- **No arbitrary values** for text, radius or shadow (`text-[11px]`). Layout values such as widths are fine.
- **Both themes:** every screen must look right in light and dark. Never assume a dark background.

### Typography

- **Roboto** is the font for all text. It is bundled with the app (`@fontsource-variable/roboto`, imported
  in `src/index.css`), so there is no request to a font service. It is a variable font: use the normal weights (`font-medium`, `font-semibold`,
  `font-bold`).
- **Code** uses `Menlo, Monaco, 'Courier New', monospace`. Use `font-mono` for anything that is code: commands, file paths,
  names, IDs, addresses, output, and code blocks. HeroUI's `Code` and `Snippet` already do.
- Fonts are defined once, in `src/index.css` (`--font-sans`, `--font-mono`). **Components never name a font**: no
  `font-[...]`, `font-serif`, `fontFamily` or `font-family`. To change a font, change it there.

### Depth, not outlines

The look is soft and borderless: surfaces are told apart by **shadow and fill**, never by lines.

- **No borders on surfaces** (no `border`, `border-divider`, `border-dashed`, `divide-y`, `variant="bordered"`, `isBordered`).
  A genuine separator is HeroUI's `Divider`, and it is rare: space and fill usually do the job.
- **Resting surfaces** (cards, tiles, the sidebar): `Card shadow="md"` on the page background. **Raised or hovered**:
  `hover:shadow-large` with a small lift. **Floating** (windows, popovers, tooltips): `shadow-large`.
  **Inside a card**: a tile with a quiet fill (`bg-default-50`, `bg-default-100/60`), no shadow. **Empty states**: a quiet fill, not a dashed box.
- **Fields and buttons are filled**: `variant="flat"` (or `solid`), never `bordered`.
- **Emphasis without outlines**: a faint tint (`bg-success/5`), an icon, or a Chip, not a colored border.
- The shadows, the page and surface colors, the radii and the dividers are defined once, in `hero.ts` (light and dark; in dark
  each shadow also carries a faint light top edge, because a shadow alone barely shows there). Change the look there, never in
  a component.

### Props and events

Use HeroUI's vocabulary on everything, including your own components: `color`, `variant`, `size`, `radius`, `shadow`,
`isDisabled`, `isLoading`, `isInvalid`, `isSelected`, `startContent`, `endContent`, `classNames`, `onPress` (not `onClick`),
`onValueChange`, `onSelectionChange`. Icon-only controls always get an `aria-label`.

### Wording

Plain English, sentence case, short. Say what happened and what to do next. Never show raw error text without a sentence of
context. No jargon where a plain word works.


## 3. When HeroUI does not have it: build it in `src/ui`

Only after checking section 2. Then:

1. **Compose from HeroUI first.** Start from `Card`, `Button`, `Chip` and friends; use a raw element only for the leaf that
   has no HeroUI equivalent (an SVG, a native color picker).
2. **One file per component** in `src/ui/`, exported from `src/ui/index.ts`.
3. **Build it the way HeroUI builds its own**: variants with `tv()` (exported from `@heroui/react`), variant names `color`
   (`default | primary | secondary | success | warning | danger`), `size` (`sm | md | lg`), `radius`, `variant`; booleans
   named `isX`; a `className` (and `classNames` for several slots); `children` for content. See `ui/IconBubble.tsx`.
4. **Tokens only** (section 2). States: hover, focus-visible, disabled, loading where they apply. Keyboard and screen-reader
   support as a HeroUI component would have.
5. **Check both themes** and a narrow window before calling it done.
6. **Add it to the catalog below.**

### Catalog of our own components

| Component | What it is |
| --- | --- |
| `IconBubble` | A tinted tile that holds an icon (`color`, `size`) |
| `HeadAvatar` | A person's or agent's pixel-art head, drawn in code from their look (`src/pixel`), in HeroUI's `Avatar` at 24 / 36 / 48 px (whole multiples of the art, so it stays sharp) |
| `ChipField` | A message field with chips: `@Marco` is one piece (Backspace removes it whole, copy and send read it as `@marco`). HeroUI's `Textarea` can't hold anything but text, so this is the one `contenteditable` leaf; it is uncontrolled and driven through a handle (`clear`, `insertChip`) |
| `ColorSwatches` | A row of colors to pick one from, on HeroUI's `RadioGroup` (arrow keys, one choice); the colors are data, so it is the one place a color may be written as a style |
| `MarkdownDoc` | A Markdown page or answer as React text (never HTML): headings, lists, tables, code, quotes, pictures the team keeps. Nothing written in it becomes a link to follow or markup |
| `Hint` | A HeroUI `Tooltip` for anything, including a disabled button or a dropdown trigger (it hangs on a wrapper) |
| `IconButton` | A small icon-only `Button` with its tooltip; `label` is both the hint and the `aria-label` |
| `Resizer` | A draggable divider between two panes: drag, double-click to reset, arrow keys |
| `ContextMenu` | A right-click menu at the pointer: a `Listbox` in a floating `Card`, with sections, submenus and keyboard support |
| `TextButton` | A small underlined text action (`Link` as a button) |
| `icons` | The line-icon set (24 px grid, `currentColor`) |
| `lucide` | The denser icons the office needs, re-exported from `lucide-react`. It is the only file allowed to import that package; a new icon is added there |

## 4. Enforcement

`npm run check` runs `tsc --noEmit`, `scripts/check-ui.mjs`, the shared-copy freshness check and the TypeScript tests (`npm test`,
Node's built-in runner). **It must pass before every commit.** The script rejects plain
`<button> <input> <select> <textarea> <a> <table> <dialog>`, `title=` tooltips, hand-built alert boxes, borders and
outlined variants, named fonts, Tailwind palette colors, hard-coded colors, arbitrary text/radius/shadow values, Tailwind's own size/radius/shadow names, other UI
libraries, and `lucide-react` imported anywhere but `ui/lucide.ts`. A real exception is written as `ui-check-ignore: <why>` on the line (or the line above), or
`ui-check-ignore-file: <why>` at the top of a file. Allowed so far: the native color picker, the Office's pixel art and sample map
(game art, in `src/pixel`, `src/office/world` and `src/shared/workspace`) and the character colors in `ColorSwatches`.
Say why; the reason is the point.

If a rule gets in the way of something good, change the rule here and in the script in the same commit instead of working
around it.

## 5. Before saying something is done

- `npm run check` passes, and so do `cd team-server && bun test` and `cd agent-service && pytest` when you touched them.
- You looked at it: run `npm run dev` (the web service must be running too, see the README), open the screen, check light and dark, and a narrow width.
- Real behavior was run, not only typechecked.
- The README and `docs/hackathon/architecture.md` are updated for what changed.
- Commits are under the developer's own name, with no AI co-author trailer.

## 6. The office and the agents

- **A mention is run by the server, never by a browser.** The client sends `agent.start`; the web service checks who may ask
  (`mayAskAgent`), answers `queued` or `thinking` so every window shows "<agent> is preparing the answer for <person>", calls
  `POST /v1/run` on the agent service with a Google-signed ID token, maps its `status` and `step` events to the room's
  `agent.status`, and posts the `final` event as a message from the agent with its `citations` and `cards`, under a
  deterministic message id so a retry never posts twice. Every way a run can end without an answer sends a failure, so the room never
  waits forever; "the demo budget is used up" is a plain reply, not an error. The contract between the two services is `src/shared/ai`.
- **The agents.** Librarian (default for lobby questions: retrieve, answer, then a verifier that strips claims the cited text does not
  support; refuses when nothing supports an answer), Scribe (End meeting: decisions, risks and action items linked to the board, minutes),
  Planner (the Plan Room: research the docs in parallel, then a plan card), Reviewer (a ticket's notes against its acceptance
  criteria), Importer (a PDF or a picture into a Docs page) and Studio (the chief of staff that routes to the others). An agent is
  `agent.json` + `persona.md` in `docs/demo-data/agents`, loaded by the web service.
- **Proposals, not actions.** An agent never creates a ticket, moves a card or saves a page. It posts a `proposal` card; **Accept**
  calls the normal REST API with the person's own token. Whatever an agent writes is scrubbed of anything that looks like a key and capped
  before it is saved.
- **Untrusted text is data.** Chat, docs and quoted emails reach the model between a random nonce, with the instruction that nothing
  inside is an order. The demo seed plants one instruction inside a quoted vendor email (`pushrelay-renewal-thread`) and the
  evaluation checks that the answer ignores it.
- **Knowledge.** Every doc and ticket change is pushed to the agent service (`POST /v1/index`, `/v1/reindex`: idempotent), cut by
  heading, embedded and kept in Firestore vector search. The agents' tools read back through the web service's `/internal/v1/*` routes,
  also with ID tokens.
- **Keys and models stay on the server.** No model name, key or service account is in the browser or an image. Model names are
  environment configuration, with retry, backoff and a fallback model on 429 and 503. Cost is bounded: a token cap per run, a per-guest
  and a global run budget, and a billing alert.
- **The hosted demo.** The server runs with `DEMO_MODE=1`: it seeds one shared, synthetic workspace from `docs/demo-data`, gives every
  visitor a short-lived signed guest token (`POST /demo/guest`), and resets the workspace every night (`POST /demo/reset`, called by Cloud
  Scheduler). The page says the data is synthetic, that it resets nightly and how many runs are left.
- **The room is laid out from the team** (`src/shared/workspace/layout.ts`, `buildOfficeMap(members)`): one lobby and one zone per member.
  The map is a pure function of the member list, so the web service and the tests draw the same room. The six agents wait in the lobby, three to a
  row and far enough apart that their name pills do not cover one another (`homeSpot` in `office/cast.ts`).
- **Pixi stays in `src/office/world`**, loaded lazily. Anything the person reads or presses is HeroUI in `src/office/*.tsx`; the canvas only draws
  the world, names and speech bubbles of people.
- **Per-room chat with sessions.** Chat follows where the avatar stands. Each room has at most one active session; the workspace owner can
  start a new one, archive the room or delete a session. Every message goes to the web service, which saves it. Style comes from the
  message's `kind`, which the server sets, never from who the client thinks sent it.
- **Checking the agents.** `cd agent-service && pytest` runs the suite on a fake model with no Google Cloud; `agent-service/eval` runs the
  golden cases over `docs/demo-data` against the real models. A number goes into the README or the deck only after a real run.
- **To try it locally**, follow "Run it locally" in the README: the agent service on its fake model, the web service in demo mode, and
  `npm run dev`.
