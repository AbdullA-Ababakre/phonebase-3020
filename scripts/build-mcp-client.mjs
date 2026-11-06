import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, parse } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'public/downloads/phonebase-mcp.mjs');
mkdirSync(dirname(output), { recursive: true });
const result = await build({
  entryPoints: [resolve(root, 'mcp/client.mjs')], outfile: output,
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  minify: false, legalComments: 'inline', metafile: true,
  banner: {js:'import { createRequire as __phonebaseCreateRequire } from "node:module"; const require = __phonebaseCreateRequire(import.meta.url);'},
});
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== parse(directory).root) {
    if (existsSync(resolve(directory, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
      if (!pkg.name || !pkg.version) { directory = dirname(directory); continue; }
      const key = `${pkg.name}@${pkg.version}`;
      if (!notices.has(key)) {
        const files = readdirSync(directory).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
        if (!files.length) throw Error(`License text missing for bundled package ${key}`);
        notices.set(key, files.map(name => readFileSync(resolve(directory, name), 'utf8')).join('\n'));
      }
      break;
    }
    directory = dirname(directory);
  }
}
const noticeText = 'Phonebase standalone MCP client — bundled third-party notices\n\n' + [...notices].sort(([a],[b])=>a.localeCompare(b)).map(([name,license])=>name+'\n'+license).join('\n\n---\n\n');
writeFileSync(output, readFileSync(output,'utf8')+'\n/*\n'+noticeText.replaceAll('*/','* /')+'\n*/\n');
writeFileSync(resolve(root,'public/downloads/phonebase-mcp.NOTICES.txt'),noticeText+'\n');
writeFileSync(output, readFileSync(output, 'utf8').replace(/[\t ]+$/gm, ''));
const bytes = readFileSync(output);
writeFileSync(output + '.sha256', createHash('sha256').update(bytes).digest('hex')+'  phonebase-mcp.mjs\n');
console.log(`Built standalone MCP client (${bytes.length} bytes), embedded ${notices.size} dependency notices, and wrote SHA-256 manifest.`);
