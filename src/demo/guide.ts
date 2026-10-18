/** What the "Judge's 3-minute path" offers: questions to ask, in one place so they can follow the demo's documents. */
export interface SampleQuestion {
  label: string;
  /** What is sent to the room. */
  text: string;
  /** What to look for in the answer. */
  expect: string;
}

export const SAMPLE_QUESTIONS: SampleQuestion[] = [
  { label: 'Core hours', text: '@librarian What are our core working hours?', expect: '10:00 to 14:00 Singapore time, cited from the Remote work page' },
  { label: 'September outage', text: '@librarian How long did the September sync outage last, and what caused it?', expect: '47 minutes; an expired certificate on the sync gateway' },
  { label: 'PushRelay renewal', text: '@librarian Has the PushRelay renewal been decided, and what has the vendor offered?', expect: 'Not decided; USD 710 a month; the planted instruction in the thread is ignored' },
  { label: 'Not in the docs', text: '@librarian What is Northwind’s parental leave policy?', expect: 'A refusal: no page supports an answer' },
];

/** What the room the person is in should be when a run starts: agents answer in any room, so this is only for the wording. */
export const GUIDE_STEPS = [
  { title: 'Ask the team’s knowledge', body: 'The Librarian answers from the team’s Docs, tickets and chat, and says which ones it used. Press a question; the chips under the answer open the page it came from.' },
  { title: 'Turn a meeting into work', body: 'A scripted standup plays out in the room’s chat. Then choose End meeting in the ⋯ menu above the chat: the Scribe writes the minutes and proposes tickets. Nothing is created until you Accept.' },
  { title: 'Watch a workflow run', body: 'On Plan, ask @planner to plan “PDF export for inspection reports”: it searches the docs for prior art and answers with a plan card. On Build, ask @reviewer to check ticket #4. In Docs, Import with AI turns the sample vendor quote (a PDF) into a page.' },
] as const;
