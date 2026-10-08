import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const PROTECTED_ENTRIES = new Set([
  '.git', '.github', '.agents', '.codex', '.aws', 'data', 'scripts', 'css', 'js',
  'index.html', '404.html', '_headers', 'robots.txt', 'README.md', 'CLAUDE.md', 'AGENTS.md',
  '.gitignore', '.node-version', '.env',
]);

function resolveExistingAncestor(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function pathIdentity(path) {
  const { dev, ino } = statSync(path);
  return `${dev}:${ino}`;
}

export function resolveBuildOutput(root, args, defaultPath, command) {
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    throw new Error(`Usage: node scripts/${command} [--output path]`);
  }
  root = realpathSync(root);
  const protectedEntries = new Set([...PROTECTED_ENTRIES, ...readdirSync(root).filter(entry => entry.startsWith('.env.'))]);
  const output = resolve(args[1] || join(root, defaultPath));
  // 父目录的符号链接和系统别名也参与保护，未创建的输出不能绕过来源路径检查。
  for (const path of [output, resolveExistingAncestor(output)]) {
    const toRoot = relative(path, root);
    const fromRoot = relative(root, path).split(sep)[0];
    if ((!toRoot.startsWith(`..${sep}`) && toRoot !== '..') || protectedEntries.has(fromRoot) || fromRoot.startsWith('.env.')) {
      throw new Error('Build output must not overwrite the repository or its source directories');
    }
  }
  // macOS 别名大小写可能在 realpath 中保留；再以 inode 校验来源文件和目录。
  const identities = new Set([...protectedEntries].map(entry => join(root, entry)).filter(existsSync).map(pathIdentity));
  for (let ancestor = output; ; ancestor = dirname(ancestor)) {
    if (existsSync(ancestor) && identities.has(pathIdentity(ancestor))) {
      throw new Error('Build output must not overwrite the repository or its source directories');
    }
    if (dirname(ancestor) === ancestor) break;
  }
  const existing = lstatSync(output, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error('Build output must not follow a symbolic link');
  if (existing?.isFile() && existing.nlink > 1) throw new Error('Build output must not overwrite a hard-linked file');
  return output;
}
