// Repair a locally built executable copied into an existing macOS app bundle.
// Run after quitting the app. This is local ad-hoc signing, not distribution signing.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyBundleLayout, planBundleLayout } from './macos-bundle-layout.mjs';

const CODESIGN = '/usr/bin/codesign';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

export function repairMacosBundle(
  bundlePath,
  {
    platform = process.platform,
    run = spawnSync,
    repairLayout = false,
    fileSystem = fs,
    onProgress = () => {},
  } = {},
) {
  if (platform !== 'darwin') throw new Error('This command must be run on macOS.');
  const { realpathSync, statSync } = fileSystem;
  const bundle = realpathSync(bundlePath);
  if (!bundle.endsWith('.app') || !statSync(bundle).isDirectory()) {
    throw new Error('Specify an existing .app bundle.');
  }

  const invoke = (program, args, allowFailure = false) => {
    const result = run(program, args, { encoding: 'utf8', shell: false });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`${program} was interrupted by ${result.signal}.`);
    if (!allowFailure && result.status !== 0) {
      throw new Error(
        `${program} failed: ${(result.stderr || result.stdout || result.signal || result.status).toString().trim()}`,
      );
    }
    return result;
  };
  const plist = join(bundle, 'Contents', 'Info.plist');
  const readPlist = (key) => invoke(PLIST_BUDDY, ['-c', `Print :${key}`, plist]).stdout.trim();
  const bundleId = readPlist('CFBundleIdentifier');
  const executableName = readPlist('CFBundleExecutable');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Invalid or missing CFBundleIdentifier.');
  if (!executableName || /[/\\]/.test(executableName) || ['.', '..'].includes(executableName)) {
    throw new Error('Invalid CFBundleExecutable.');
  }
  const executable = realpathSync(join(bundle, 'Contents', 'MacOS', executableName));
  const relativeExecutable = relative(bundle, executable);
  if (
    isAbsolute(relativeExecutable) ||
    relativeExecutable.startsWith(`..${sep}`) ||
    !statSync(executable).isFile()
  ) {
    throw new Error('The main executable must be a file inside the app bundle.');
  }

  const verify = () => invoke(CODESIGN, ['--verify', '--strict', '--verbose=2', bundle], true);
  const signedIdentifier = () => {
    const result = invoke(CODESIGN, ['--display', '--verbose=2', bundle]);
    const identifier = `${result.stdout || ''}\n${result.stderr || ''}`
      .match(/^Identifier=(.+)$/m)?.[1]
      .trim();
    if (!identifier) throw new Error('Could not read the signing identifier.');
    return identifier;
  };

  if (verify().status === 0 && signedIdentifier() === bundleId) {
    return { bundle, bundleId, resigned: false };
  }

  const isCode = (path) => {
    const fd = fileSystem.openSync(path, 'r');
    const magic = Buffer.alloc(4);
    let count;
    try {
      count = fileSystem.readSync(fd, magic, 0, 4, 0);
    } finally {
      fileSystem.closeSync(fd);
    }
    if (
      count !== 4 ||
      ![
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ].includes(magic.readUInt32BE(0))
    )
      return false;
    // file also distinguishes universal Mach-O binaries from Java's CAFEBABE header.
    const kind = invoke('/usr/bin/file', ['-b', path]).stdout;
    return /Mach-O/.test(kind) && /executable|shared library|bundle/.test(kind);
  };
  onProgress('Inspecting the app bundle layout...');
  const plan = planBundleLayout(bundle, executableName, isCode, fileSystem);
  if (plan.moves.length && !repairLayout) {
    throw new Error(
      `Data files are stored in Contents/MacOS (${plan.moves
        .map((move) => relative(bundle, move.source))
        .slice(0, 4)
        .join(
          ', ',
        )}). Re-run with --repair-layout to relocate resources and retain compatible symlinks.`,
    );
  }
  // Preserve already signed agents/frameworks, and diagnose invalid nested code before moving data.
  onProgress(`Checking ${plan.codeObjects.length} nested code object(s)...`);
  for (const code of plan.codeObjects) {
    const result = invoke(CODESIGN, ['--verify', '--strict', '--verbose=2', code], true);
    if (result.status !== 0) {
      throw new Error(
        `Nested code must have a valid signature before repairing the app: ${code}\n${result.stderr || result.stdout || ''}`,
      );
    }
  }

  const signature = join(bundle, 'Contents', '_CodeSignature');
  let signatureStat;
  try {
    signatureStat = fileSystem.lstatSync(signature);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (signatureStat && (!signatureStat.isDirectory() || signatureStat.isSymbolicLink())) {
    throw new Error('The bundle signature location must be a real directory.');
  }
  const backup = fileSystem.mkdtempSync(join(tmpdir(), 'mxu-bundle-signing-'));
  let transaction;
  let signingStarted = false;
  let keepBackup = false;
  try {
    fileSystem.copyFileSync(executable, join(backup, 'executable'));
    if (signatureStat) fileSystem.cpSync(signature, join(backup, 'signature'), { recursive: true });
    onProgress(`Recovery copy: ${backup}`);
    for (const move of plan.moves) {
      onProgress(
        `Relocate ${relative(bundle, move.source)} -> ${relative(bundle, move.destination)}`,
      );
    }
    transaction = applyBundleLayout(plan, fileSystem);
    // Signing only the outer app seals resources and binds Info.plist; no --deep re-signing of agents.
    signingStarted = true;
    invoke(CODESIGN, ['--force', '--sign', '-', '--identifier', bundleId, bundle]);
    const verification = verify();
    if (verification.status !== 0) {
      throw new Error(
        `Bundle signature verification failed: ${(verification.stderr || verification.stdout || '').trim()}`,
      );
    }
    if (signedIdentifier() !== bundleId) {
      throw new Error('The signing identifier still does not match CFBundleIdentifier.');
    }
    return { bundle, bundleId, resigned: true, relocated: plan.moves.length };
  } catch (error) {
    const recoveryErrors = [];
    if (signingStarted) {
      try {
        fileSystem.copyFileSync(join(backup, 'executable'), executable);
        fileSystem.rmSync(signature, { recursive: true, force: true });
        if (signatureStat)
          fileSystem.cpSync(join(backup, 'signature'), signature, { recursive: true });
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
    }
    try {
      transaction?.rollback();
    } catch (restoreError) {
      recoveryErrors.push(restoreError);
    }
    if (recoveryErrors.length || (error instanceof AggregateError && !transaction)) {
      keepBackup = true;
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Repair failed; recovery copy retained at ${backup}`,
      );
    }
    throw error;
  } finally {
    if (!keepBackup) fileSystem.rmSync(backup, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const repairLayout = args[0] === '--repair-layout';
    if (repairLayout) args.shift();
    if (args.length !== 1) {
      throw new Error(
        'Usage: node scripts/macos-resign.mjs [--repair-layout] /path/to/YourApp.app (quit the app first)',
      );
    }
    const result = repairMacosBundle(args[0], { repairLayout, onProgress: console.log });
    console.log(
      `${result.resigned ? 'Re-signed and verified' : 'Signature already valid'}: ${result.bundle}`,
    );
    console.log(`Signing identifier: ${result.bundleId}`);
    console.log('Relaunch the .app before testing notifications.');
  } catch (error) {
    console.error(error.message);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error(cause.message);
    }
    process.exitCode = 1;
  }
}
