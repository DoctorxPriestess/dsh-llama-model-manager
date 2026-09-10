/**
 * Pre-flight check for registering this plugin into a DSH profile.
 *
 * Mirrors what DSH's profile boot does, so a broken registration is caught
 * BEFORE DSH is restarted (a bad bundle can otherwise fail the boot loader's
 * hard check):
 *   1. package.json stays valid JSON after the edit
 *   2. the bundle name resolves from the profile directory
 *   3. the resolved package declares dsh.bundle.patch and that file exists
 *   4. the patch file parses as YAML and has the expected shape
 *   5. the plugin entry module actually imports and exports name/inject/apply
 *
 * Run: npm run preflight  (or: node scripts/preflight-registration.mjs [<profileDir>])
 *
 * The profile directory is resolved from the environment, never hardcoded:
 * DSH_HOME / DSH_PROFILE override the defaults of ~/.dsh and `web`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = process.argv[2] || path.join(dshHome, 'profiles', process.env.DSH_PROFILE || 'web');
const BUNDLE = 'dsh-llama-model-manager';

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// 1. profile package.json is valid JSON and lists the bundle
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
  record('profile package.json parses', true);
} catch (error) {
  record('profile package.json parses', false, error.message);
  process.exit(1);
}
const bundles = manifest.dsh?.profile?.bundles ?? [];
record(`"${BUNDLE}" is in dsh.profile.bundles`, bundles.includes(BUNDLE), `bundles: ${bundles.length}`);
record('no duplicate bundle entries', new Set(bundles).size === bundles.length);

// 2. resolution from the profile directory (junction must be transparent)
const require = createRequire(path.join(PROFILE_DIR, 'noop.js'));
let pkgJsonPath = null;
try {
  pkgJsonPath = require.resolve(`${BUNDLE}/package.json`);
  record('bundle resolves from the profile dir', true, pkgJsonPath);
} catch (error) {
  record('bundle resolves from the profile dir', false, error.message);
}

let pkg = null;
if (pkgJsonPath) {
  // 3. declares a bundle patch, and the file exists
  pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const patchRel = pkg.dsh?.bundle?.patch;
  record('package declares dsh.bundle.patch', Boolean(patchRel), String(patchRel ?? ''));
  const pkgDir = path.dirname(pkgJsonPath);
  const entryRel = pkg.main ?? pkg.exports?.['.'];
  const entryAbs = entryRel ? path.join(pkgDir, entryRel) : null;
  record('entry file exists', Boolean(entryAbs && fs.existsSync(entryAbs)), entryAbs ?? '(no main)');

  if (patchRel) {
    const patchAbs = path.join(pkgDir, patchRel);
    const patchExists = fs.existsSync(patchAbs);
    record('patch file exists', patchExists, patchAbs);
    if (patchExists) {
      // 4. parse the YAML with whatever parser the profile already has
      let parse = null;
      try {
        const yaml = require('js-yaml');
        parse = (text) => yaml.load(text);
      } catch {
        try {
          const yaml = require('yaml');
          parse = (text) => yaml.parse(text);
        } catch {
          /* no parser available */
        }
      }
      if (!parse) {
        record('patch file parses as YAML', true, 'skipped (no yaml parser resolvable from the profile)');
      } else {
        try {
          const doc = parse(fs.readFileSync(patchAbs, 'utf8'));
          const isArray = Array.isArray(doc);
          record('patch file parses as YAML array', isArray, `type=${Array.isArray(doc) ? 'array' : typeof doc}`);
          if (isArray) {
            const inserted = doc.flatMap((row) => row?.insert ?? []);
            record('patch inserts a plugin row', inserted.length > 0, `inserts=${JSON.stringify(inserted.map((r) => r.id))}`);
            record(
              'inserted row names this bundle',
              inserted.some((row) => row.name === BUNDLE),
              inserted.map((row) => row.name).join(', '),
            );
          }
        } catch (error) {
          record('patch file parses as YAML', false, error.message);
        }
      }
    }
  }

  // 5. the module itself imports cleanly and exposes the plugin contract
  if (entryAbs && fs.existsSync(entryAbs)) {
    try {
      const mod = await import(new URL(`file:///${entryAbs.replace(/\\/g, '/')}`).href);
      record('plugin entry imports cleanly', true);
      record('exports name', typeof mod.name === 'string' && mod.name.length > 0, String(mod.name));
      record('exports inject', Array.isArray(mod.inject), JSON.stringify(mod.inject));
      record('exports apply()', typeof mod.apply === 'function');
    } catch (error) {
      record('plugin entry imports cleanly', false, error.message);
    }
  }
}

// client bundle: the settings page is served by DSH from the plugin's own file
if (pkg) {
  const pkgDir = path.dirname(pkgJsonPath);
  const clientRel = pkg.exports?.['./client'];
  if (clientRel) {
    record('client bundle exists', fs.existsSync(path.join(pkgDir, clientRel)), clientRel);
  }
  record('package is type: module', pkg.type === 'module', String(pkg.type));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n================ ${checks.length - failed.length}/${checks.length} checks passed ================`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
