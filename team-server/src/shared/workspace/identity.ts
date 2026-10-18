// Copied from Worktrees Studio (src/shared/workspace) by `npm run sync-core`. Do not edit here.
/**
 * The form of an email address that people are compared by: lower case, and for Gmail the dots and the `+tag` ignored
 * (`First.Last+work@googlemail.com` is `firstlast@gmail.com`), because Google delivers all of those to one mailbox.
 * Other providers are only lower-cased: `ann+dev@corp.com` is a different address from `ann@corp.com` until we know that
 * their provider treats them alike, so an invitation has to be sent to the address the person signs in with.
 */
export function normalizeEmail(email: string | undefined | null): string {
  const e = (email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  // Nothing left of the name (`+tag@gmail.com`): keep what was typed, so different mistakes don't all become `@gmail.com`.
  if (!local) return e;
  return `${local}@${domain}`;
}

/** A plausible address, short enough, with no control characters. (Whether it exists is Google's business.) */
export function validEmail(email: unknown): email is string {
  if (typeof email !== 'string' || email.length > 254) return false;
  if (!/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(email)) return false;
  // At Gmail, a name that is nothing but dots or a plus tag is nobody's address.
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();
  const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
  return !(gmail && email.slice(0, at).split('+')[0].replace(/\./g, '') === '');
}
