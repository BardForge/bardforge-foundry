import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Include untracked candidates so a pre-stage check cannot silently inspect an empty index.
const paths = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const forbidden =
  /(^|\/)(?:\.?superpowers|\.codex|private|internal|node_modules|tmp|dist|build|coverage|test-results|playwright-report|models)(\/|$)|(^|\/)(?:AGENTS|CLAUDE)\.md$|BardForge_(?:Studio_Concept_TZ|GIT_AGENT_RULES)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|sqlite3?|db|wav|mp3|ogg|flac)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
];
const problems = [];
for (const file of paths) {
  if (!process.argv.includes('--secrets-only') && forbidden.test(file))
    problems.push(`Private or generated path: ${file}`);
  if (process.argv.includes('--paths-only')) continue;
  if (/\.(?:png|jpg|webp|ico|woff2?)$/i.test(file)) continue;
  const content = readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(content)))
    problems.push(`Possible credential in: ${file}`);
}
if (paths.length === 0) problems.push('No public source files found');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${paths.length} tracked/untracked public paths checked; no prohibited files or recognized credential patterns.`,
  );
