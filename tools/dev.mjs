#!/usr/bin/env node
/**
 * Task runner for the proposal generator.
 *
 * Exists mainly to paper over the two-runtime split: the geometry tools are
 * Node and the renderer is Python, and the venv interpreter sits at a different
 * path on Windows than on POSIX. Everything is driven through `npm run` so
 * there is one obvious way in.
 *
 *   node tools/dev.mjs setup
 *   node tools/dev.mjs render seo-only [--theme themes/forest.json]
 *   node tools/dev.mjs verify seo-only
 *   node tools/dev.mjs extract
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'services', 'renderer');
const VENV = path.join(RENDERER, '.venv');
const BUILD = path.join(ROOT, 'build');
const TEMPLATES = ['seo-only', 'seo-ads'];

const isWindows = process.platform === 'win32';
const venvPython = () =>
  path.join(VENV, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
  return res;
}

/**
 * Runs `npm install` in a directory.
 *
 * Node 22+ refuses to spawnSync a `.cmd` file without a shell (EINVAL, from the
 * batch-argument-injection mitigation), and passing args *with* shell:true is
 * deprecated. Both are dodged by invoking npm's JS entry point with the current
 * node binary. npm exposes that path as npm_execpath whenever it runs a script,
 * which is always the case here since this is reached via `npm run setup`.
 */
function npmInstall(cwd) {
  const npmJs = process.env.npm_execpath;
  if (npmJs && npmJs.endsWith('.js')) {
    run(process.execPath, [npmJs, 'install', '--silent'], { cwd });
    return;
  }
  // Fallback for a direct `node tools/dev.mjs setup` invocation, where npm set
  // no environment. shell:true is required to resolve npm.cmd on Windows.
  run(isWindows ? 'npm.cmd' : 'npm', ['install', '--silent'], { cwd, shell: isWindows });
}

/** Finds a usable system Python, preferring the py launcher on Windows. */
function systemPython() {
  const candidates = isWindows
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];

  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { encoding: 'utf8' });
    // The Windows Store stub exits non-zero and prints an install nag rather
    // than a version, so a clean exit is the thing to check for.
    if (res.status === 0 && /Python 3/.test(res.stdout + res.stderr)) {
      return cmd === 'py' ? { cmd, prefix: ['-3'] } : { cmd, prefix: [] };
    }
  }
  return null;
}

const tasks = {
  setup() {
    console.log('> installing Node dependencies (tools/extract)');
    npmInstall(path.join(ROOT, 'tools', 'extract'));

    console.log('> installing Node dependencies (apps/web)');
    npmInstall(path.join(ROOT, 'apps', 'web'));

    if (!fs.existsSync(venvPython())) {
      const py = systemPython();
      if (!py) {
        console.error(
          '\nerror: no Python 3 found on PATH.\n' +
            'Install it (winget install Python.Python.3.12) and re-run `npm run setup`.\n' +
            'Note: the Microsoft Store stub at WindowsApps\\python.exe does not count.',
        );
        process.exit(1);
      }
      console.log('> creating Python venv (services/renderer/.venv)');
      run(py.cmd, [...py.prefix, '-m', 'venv', VENV]);
    } else {
      console.log('> Python venv already present');
    }

    console.log('> installing Python dependencies');
    run(venvPython(), [
      '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip',
      '-r', path.join(RENDERER, 'requirements.txt'),
    ]);
    console.log('\nsetup complete. try: npm run render');
  },

  extract() {
    for (const t of TEMPLATES) {
      run(process.execPath, [
        path.join(ROOT, 'tools', 'extract', 'extract-layout.mjs'),
        path.join(ROOT, 'templates', 'golden', `${t}.pdf`),
        t,
      ]);
    }
    // The content schema is derived from the geometry, so it is always rebuilt
    // alongside it - a stale slot file would budget copy against old frames.
    run(process.execPath, [path.join(ROOT, 'tools', 'extract', 'build-slots.mjs'), ...TEMPLATES]);
  },

  render(args) {
    ensureSetup();
    const { templates, themePath, themeSuffix, strict } = parseArgs(args);
    // The gate compares against the golden decks, which always draw their logo
    // panels, so the CLI keeps them. The app suppresses empty ones instead.
    const passthrough = ['--keep-empty-logo-panels', '--icon-style', 'font'];
    if (themePath) passthrough.push('--theme', themePath);
    if (strict) passthrough.push('--strict');

    for (const t of templates) {
      run(venvPython(), [
        path.join(RENDERER, 'render.py'),
        '--template', t,
        '--out', path.join(BUILD, `${t}${themeSuffix}.pdf`),
        ...passthrough,
      ]);
    }
    console.log(`\noutput in ${path.relative(process.cwd(), BUILD) || 'build'}/`);
  },

  verify(args) {
    ensureSetup();
    const { templates, themePath, themeSuffix } = parseArgs(args);

    for (const t of templates) {
      const pdf = path.join(BUILD, `${t}${themeSuffix}.pdf`);
      if (!fs.existsSync(pdf)) {
        console.error(`error: ${pdf} not found - run \`npm run render\` first.`);
        process.exit(1);
      }
      const extra = themePath ? ['--theme', themePath] : [];
      run(process.execPath, [
        path.join(ROOT, 'tools', 'extract', 'verify-fidelity.mjs'), t, pdf, ...extra,
      ]);
    }
  },
};

/**
 * Splits template names from flags.
 *
 * The value after `--theme` must be consumed explicitly, or it gets mistaken
 * for a template name and the render fails looking for a layout spec called
 * "themes/forest.json".
 */
function parseArgs(args) {
  const templates = [];
  let themeRel = null;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--theme') themeRel = args[++i];
    else if (a === '--strict') strict = true;
    else if (!a.startsWith('--')) templates.push(a);
  }

  const unknown = templates.filter((t) => !TEMPLATES.includes(t));
  if (unknown.length) {
    console.error(
      `error: unknown template(s): ${unknown.join(', ')}. known: ${TEMPLATES.join(', ')}`,
    );
    process.exit(1);
  }

  if (themeRel) {
    const resolved = path.resolve(RENDERER, themeRel);
    if (!fs.existsSync(resolved)) {
      console.error(`error: theme not found: ${resolved}`);
      process.exit(1);
    }
    themeRel = resolved;
  }

  return {
    templates: templates.length ? templates : TEMPLATES,
    themePath: themeRel,
    themeSuffix: themeRel ? `-${path.basename(themeRel, '.json')}` : '',
    strict,
  };
}

function ensureSetup() {
  if (!fs.existsSync(venvPython())) {
    console.error('error: Python venv missing. run `npm run setup` first.');
    process.exit(1);
  }
}

const [task, ...args] = process.argv.slice(2);
if (!task || !tasks[task]) {
  console.error(`usage: node tools/dev.mjs <${Object.keys(tasks).join('|')}> [args]`);
  process.exit(1);
}
tasks[task](args);
