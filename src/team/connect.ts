import { demoOrigin } from '../web.ts';

/** The server the board, docs and agents talk to: the one that served the page, so there is nothing to confirm. */
export const teamOrigin = (): string => demoOrigin();
