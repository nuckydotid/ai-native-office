// Reading the stores for the flow rules (src/flow.ts). The sidebar, its state lines and the stage panel's
// next step all come from here, so they can never disagree with each other.

import { useMemo } from 'react';
import { useBoard } from './board/store.ts';
import { useOffice } from './office/store.ts';
import type { FlowData } from './flow.ts';

export function useFlowData(): FlowData {
  const board = useBoard((s) => s.snapshot);
  const unread = useOffice((s) => s.hiddenUnread);

  return useMemo(() => {
    const tickets = (board?.issues ?? []).map((issue) => ({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
      ...(issue.pipeline ? { stage: issue.pipeline.stage } : {}),
      assignee: issue.assignee,
    }));
    return {
      boardKnown: board !== null,
      tickets,
      me: board?.you ?? null,
      unread,
    };
  }, [board, unread]);
}
