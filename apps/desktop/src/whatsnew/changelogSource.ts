/**
 * CHANGELOG.md, bundled into the app at build time and parsed once. Kept apart
 * from changelog.ts so the parser is testable without Vite's `?raw`.
 */
import md from '../../../../CHANGELOG.md?raw'
import { parseChangelog, type Release } from './changelog.js'

export const RELEASES: readonly Release[] = parseChangelog(md)
