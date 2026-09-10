'use strict';
/**
 * Static link-check for the browser modules: every named import must actually
 * be exported by the module it comes from. A typo here only shows up as a blank
 * page at runtime, so it is worth catching in CI.
 *
 *   node scripts/check-imports.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public', 'js');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

function exportedNames(source) {
  const names = new Set();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) names.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim();
      if (name) names.add(name.split(/\s+as\s+/).pop().trim());
    }
  }
  return names;
}

const files = walk(root);
const modules = new Map(files.map((f) => [f, exportedNames(fs.readFileSync(f, 'utf8'))]));
const problems = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!modules.has(target)) {
      problems.push(`${path.relative(root, file)}: cannot resolve '${m[2]}'`);
      continue;
    }
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (local && !modules.get(target).has(local)) {
        problems.push(`${path.relative(root, file)}: imports '${local}' from '${m[2]}' which does not export it`);
      }
    }
  }
}

for (const [file, names] of modules) {
  process.stdout.write(`  ${path.relative(root, file).padEnd(24)} exports: ${[...names].sort().join(', ') || '(none)'}\n`);
}
process.stdout.write(`\n${files.length} modules checked\n`);
if (problems.length) {
  for (const p of problems) process.stderr.write(`  FAIL ${p}\n`);
  process.exit(1);
}
process.stdout.write('all named imports resolve\n');
