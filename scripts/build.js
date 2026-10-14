import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'src', 'public', 'samples']) {
  await cp(path.join(root, name), path.join(out, name), { recursive: true });
}
console.log('TraceTidy built → dist (static assets, no runtime dependencies)');
