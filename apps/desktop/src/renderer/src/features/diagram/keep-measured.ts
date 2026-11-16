/**
 * Nodes made again by a layout keep the size the canvas measured for them. React Flow hides a node without
 * measured dimensions and measures it again only when a measured node loses them; a layout that lands between a
 * rebuild and its measurement left the node unmeasured in the same render, so nothing asked again and the table
 * stayed invisible (about one layout in ten after adding a table to a diagram). A box whose content changed is
 * measured again by its resize.
 */
export function keepMeasured<N extends { id: string; measured?: { width?: number; height?: number } }>(previous: N[], next: N[]): N[] {
  const measured = new Map(previous.filter((n) => n.measured?.width && n.measured.height).map((n) => [n.id, n.measured]))
  return next.map((n) => (n.measured || !measured.has(n.id) ? n : { ...n, measured: measured.get(n.id) }))
}
