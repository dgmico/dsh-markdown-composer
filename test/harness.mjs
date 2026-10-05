/**
 * Test harness: materialize the shipped client bundle in this realm and hand
 * back the plugin factory's exports, so the tests exercise the exact artifact
 * the Web client loads rather than a copy of it.
 *
 * The bundle is evaluated through `new Function` with the browser globals it
 * touches as parameters: that keeps every value the bundle produces in the
 * test realm (so `assert.deepEqual` compares like with like) while still
 * proving the bundle only needs the globals the Web shell provides.
 *
 * @module test/harness
 */
import { readFileSync } from 'node:fs'

/** Module-table words the Web shell seeds; a bundle may require only these. */
export const MODULE_TABLE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Every bare module specifier the bundle requires.
 * @param source - the bundle's text.
 * @returns the distinct specifiers, in source order.
 */
export function requiredSpecifiers(source) {
  const found = new Set()
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let match
  while ((match = pattern.exec(source)) !== null) found.add(match[1])
  return [...found]
}

/**
 * Load `lib/client.js` and materialize its factory.
 * @param options - optional module stubs and global overrides.
 * @returns the bundle's registration, its exports and the globals it saw.
 */
export function loadClientHalf(options = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = []
  const globals = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
      open() {},
      requestAnimationFrame() {},
      localStorage: undefined,
    },
    document: undefined,
    navigator: undefined,
    Element: class Element {},
    ...options.globals,
  }
  const names = Object.keys(globals)
  // eslint-disable-next-line no-new-func -- the bundle is a classic script by contract
  const evaluate = new Function(...names, source)
  evaluate(...names.map((name) => globals[name]))

  if (registrations.length !== 1) {
    throw new Error(`expected exactly one bundle registration, saw ${registrations.length}`)
  }
  const registration = registrations[0]
  const stubs = options.modules ?? {}
  const requireStub = (specifier) => {
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier]
    if (MODULE_TABLE.includes(specifier)) return {}
    throw new Error(`bundle required an off-table module: ${specifier}`)
  }
  return { source, registration, exports: registration.factory(requireStub), globals }
}

/**
 * A slot-service stub recording every registration.
 * @returns the stub plus its recorded registrations.
 */
export function slotStub() {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    service: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(spec, Component) {
        registered.push({ spec, Component })
        return () => {}
      },
    },
  }
}

/**
 * A Cordis-context stub covering exactly what the plugin's apply touches.
 * @param slots - the slot-service stub to expose.
 * @returns the context stub plus the effects it ran.
 */
export function contextStub(slots) {
  const effects = []
  const locales = []
  return {
    effects,
    locales,
    context: {
      get(name) {
        if (name === 'slots') return slots
        if (name === 'locale') {
          return {
            register(ns, dicts) {
              locales.push({ ns, dicts })
              return () => {}
            },
          }
        }
        return undefined
      },
      effect(callback) {
        effects.push(callback())
        return () => {}
      },
      logger: { debug() {}, error() {} },
    },
  }
}
