import { useCallback, useEffect, useState } from 'react';
import { currentGuest, type Guest } from './web';

export type AuthUser = { email: string; name: string | null; picture: string | null; /** The guest's id. */ sub?: string };
type Phase = 'loading' | 'signedOut' | 'signingIn' | 'signedIn';

/** A guest of the demo as the app's signed-in person. The address is made up and never leaves the app: it only seeds the look. */
const guestUser = (g: Guest): AuthUser => ({ email: `${g.uid}@guest.invalid`, name: g.name, picture: null, sub: g.uid });

const COULD_NOT = 'The demo couldn’t let you in just now. Try again in a moment.';

/** Nobody signs in: the server hands out a guest, and that is who the person is from the first moment. */
export function useAuth() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const restored = guestUser(await currentGuest());
        if (!alive) return;
        setUser(restored);
        setPhase('signedIn');
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : COULD_NOT);
        setPhase('signedOut');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Asks the server for a guest again, after it could not give one. */
  const signIn = useCallback(async () => {
    setError(null);
    setPhase('signingIn');
    try {
      setUser(guestUser(await currentGuest()));
      setPhase('signedIn');
    } catch (e) {
      setPhase('signedOut');
      setError(e instanceof Error ? e.message : COULD_NOT);
    }
  }, []);

  return { phase, user, error, signIn };
}
