/**
 * Copies the shared spec into the app so it can be deployed.
 *
 * Vercel builds with the project root set to apps/web, and only that directory
 * ships. `packages/spec` sits outside it, so anything reading it at runtime
 * works locally and 500s in production. Copying it in at build time keeps one
 * source of truth in the repo while giving the deployment a local copy.
 *
 * The copy is gitignored - it is a build artifact, not a second original.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SOURCE = path.resolve(APP, '..', '..', 'packages', 'spec');
const DEST = path.join(APP, 'spec');

const WANTED = [
  'palette.json',
  path.join('content', 'bindings.json'),
  path.join('content', 'logos.json'),
  path.join('content', 'seo-only.slots.json'),
  path.join('content', 'seo-ads.slots.json'),
];

if (!fs.existsSync(SOURCE)) {
  console.error(
    `sync-spec: cannot find ${SOURCE}\n` +
      'The shared spec must be present at build time. If this is a deployment, ' +
      'make sure the whole repository is checked out, not just apps/web.',
  );
  process.exit(1);
}

let copied = 0;
for (const rel of WANTED) {
  const from = path.join(SOURCE, rel);
  const to = path.join(DEST, rel);

  if (!fs.existsSync(from)) {
    console.error(`sync-spec: missing required file ${rel} - run \`npm run extract\` first.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

console.log(`sync-spec: copied ${copied} file(s) into apps/web/spec`);
