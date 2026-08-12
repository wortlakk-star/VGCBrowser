import { resolve } from 'path'
import { validateBundledHiExtension } from '../src/main/bundled-hi-extension'

const extensionDir = resolve(process.cwd(), 'resources/extensions/HI')
console.log(`PASS: bundled HI v1.3.3 verified at ${validateBundledHiExtension(extensionDir)}`)
