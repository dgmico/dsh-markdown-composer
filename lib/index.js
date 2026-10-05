/**
 * Markdown composer — Host half.
 *
 * The feature itself lives entirely in the browser half (`lib/client.js`): the
 * composer draft is client state, so preview rendering, the formatting toolbar,
 * and the syntax shortcuts all run in the Web client. This Host half exists
 * because a profile bundle row imports the package root on the Host side; it
 * deliberately mounts nothing and injects no service, so the plugin can never
 * delay or perturb Host startup.
 *
 * @module dsh-markdown-composer
 */

/** Plugin name, as the loader row and logs report it. */
export const name = 'markdown-composer'

/** No Host Services are read: the plugin mounts nothing on the Host. */
export const inject = []

/**
 * Mount the (empty) Host half.
 * @param ctx - owning Cordis context.
 */
export function apply(ctx) {
  ctx.logger?.debug?.('markdown-composer: client-only plugin; the browser half owns every feature')
}
