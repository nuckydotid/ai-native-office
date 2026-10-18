/** Opens a link in a new tab, without giving the page it opens a handle back to this one. */
export async function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
