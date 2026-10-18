import type { ArtifactDraft, ArtifactKind, PipelineStage } from '../pipeline/types.ts';
import type { AgentPhase } from '../workspace/protocol.ts';
import type { ChatCard, Citation } from '../workspace/types.ts';

export type { Citation, ProposalItem } from '../workspace/types.ts';
export type { AgentPhase } from '../workspace/protocol.ts';

/**
 * The contract between the team server and the agent service (`agent-service/`, Python, Google ADK on Cloud Run).
 * The team server owns the workplace (people, rooms, tickets, docs); the agent service owns the thinking. The browser never
 * talks to the agent service: it asks in a room, the team server runs the agent, and the answer arrives as a chat message.
 */

/**
 * What an agent run is for. `spec`, `design`, `implement`, `tests`, `release_pack` and `rollout_review` belong to the delivery pipeline:
 * each is started from a stage page for one ticket and ends in an artifact for a person to accept.
 */
export const RUN_KINDS = ['mention', 'plan', 'minutes', 'review', 'import', 'spec', 'design', 'implement', 'tests', 'release_pack', 'rollout_review'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface RunAgent {
  handle: string;
  displayName: string;
  role: string;
  /** The agent's own instructions (the Agents page edits them). Quoted to the model as the agent's character, never as policy. */
  persona: string;
  skills: { name: string; body: string }[];
}

export interface RunHistoryLine {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
  kind: 'human' | 'agent' | 'system';
}

export interface RunBoardLine {
  key: number;
  title: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  assignee?: string;
  pr?: string;
}

export interface RunDocLine {
  id: string;
  title: string;
  parent?: string;
}

export interface RunAttachment {
  name: string;
  mime: string;
  dataBase64: string;
}

/** The ticket a pipeline run works on, and what the pipeline already holds for it (bodies are read through the agent's tools). */
export interface RunTicket {
  id: string;
  key: number;
  title: string;
  body: string;
  stage: PipelineStage;
}

export interface RunArtifactLine {
  id: string;
  kind: ArtifactKind;
  state: 'draft' | 'accepted' | 'superseded' | 'rejected';
  version: number;
  title: string;
}

/** `POST {agent-service}/v1/run`. */
export interface RunRequest {
  runId: string;
  kind: RunKind;
  agent: RunAgent;
  asker: { uid: string; name: string };
  /** `lobby`, `plan`, `review` or `z-<uid>`. */
  room: string;
  question: string;
  /** The room's recent conversation, oldest first, at most `AI_LIMITS.history`. Untrusted data. */
  history: RunHistoryLine[];
  context: { board: RunBoardLine[]; docs: RunDocLine[] };
  attachments: RunAttachment[];
  /** Set for a pipeline run. Absent for a question in a room. */
  ticket?: RunTicket;
  artifacts?: RunArtifactLine[];
  /** The team server's own address, for the agent's tool calls to `/internal/v1/*`. */
  webBase: string;
}

export interface RunUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

export interface RunFinal {
  text: string;
  citations: Citation[];
  cards: ChatCard[];
  /** What a pipeline agent drafted. The server keeps each as a draft and offers them in one proposal card; an agent cannot name an id. */
  artifacts?: ArtifactDraft[];
  usage: RunUsage;
}

export type RunErrorCode = 'budget' | 'model_unavailable' | 'invalid' | 'internal';

/** The events of the `text/event-stream` answer to `POST /v1/run` (`event:` is the name, `data:` the JSON). */
export type RunEvent =
  | { event: 'status'; data: { phase: AgentPhase } }
  | { event: 'step'; data: { tool: string; summary: string } }
  | { event: 'final'; data: RunFinal }
  | { event: 'error'; data: { code: RunErrorCode; message: string } };

/** `POST {agent-service}/v1/index` (one item) and `/v1/reindex` (many): what the agent may know. Idempotent. */
export interface IndexItem {
  kind: 'doc' | 'ticket';
  /** A page's id, or a ticket's number as text. */
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted?: boolean;
}

export const AI_LIMITS = {
  /** Messages of conversation sent with a run. */
  history: 40,
  /** One line of that conversation, in characters. */
  historyLine: 1200,
  /** Tickets and docs listed to the agent as context. */
  board: 60,
  docs: 100,
  citations: 8,
  quote: 240,
  /** What the server accepts from an agent: the chat limit for an answer (see `LIMITS.agentText`). */
  answer: 6000,
  /** An imported file, before base64. */
  importBytes: 4 * 1024 * 1024,
} as const;
