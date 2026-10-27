import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function statIfPresent(fileSystem, path) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function checkDestinationParents(bundle, directory, fileSystem) {
  if (!inside(bundle, directory)) throw new Error(`Path leaves the app bundle: ${directory}`);
  for (let path = directory; path !== bundle; path = dirname(path)) {
    const stat = statIfPresent(fileSystem, path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Resource destination must use real directories: ${path}`);
    }
  }
}

/** Plan before changing anything. Keep executable paths and existing symlinks intact. */
export function planBundleLayout(bundle, executableName, isCode, fileSystem = fs) {
  const macos = join(bundle, 'Contents', 'MacOS');
  const resources = join(bundle, 'Contents', 'Resources', 'MXU-portable');
  const main = join(macos, executableName);
  checkDestinationParents(bundle, macos, fileSystem);
  checkDestinationParents(bundle, resources, fileSystem);
  const codeObjects = [];

  const inspect = (path) => {
    const stat = fileSystem.lstatSync(path);
    if (path === main) return { path, keep: true };
    if (stat.isSymbolicLink()) {
      if (!inside(bundle, fileSystem.realpathSync(path))) {
        throw new Error(`Bundle symlink points outside the app: ${path}`);
      }
      return { path, keep: true };
    }
    if (stat.isDirectory()) {
      if (/\.(app|framework|bundle|xpc)$/i.test(path)) {
        codeObjects.push(path);
        return { path, keep: true };
      }
      const children = fileSystem
        .readdirSync(path)
        .sort()
        .map((name) => inspect(join(path, name)));
      return { path, directory: true, keep: children.some((child) => child.keep), children };
    }
    if (!stat.isFile()) throw new Error(`Unsupported file in app bundle: ${path}`);
    const keep = isCode(path);
    if (keep) codeObjects.push(path);
    return { path, directory: false, keep };
  };

  const moves = [];
  const collect = (entry) => {
    if (!entry.keep) {
      const destination = join(resources, relative(macos, entry.path));
      checkDestinationParents(bundle, dirname(destination), fileSystem);
      if (statIfPresent(fileSystem, destination)) {
        throw new Error(`Refusing to overwrite existing resource: ${destination}`);
      }
      moves.push({ source: entry.path, destination, directory: entry.directory });
    } else {
      entry.children?.forEach(collect);
    }
  };
  fileSystem
    .readdirSync(macos)
    .sort()
    .map((name) => inspect(join(macos, name)))
    .forEach(collect);
  return { bundle, moves, codeObjects };
}

/** All moves stay inside the same .app; relative links retain the old lookup paths. */
export function applyBundleLayout(plan, fileSystem = fs) {
  const moved = [];
  const createdDirectories = [];
  const makeDirectory = (path) => {
    if (statIfPresent(fileSystem, path)) return;
    makeDirectory(dirname(path));
    fileSystem.mkdirSync(path);
    createdDirectories.push(path);
  };
  const rollback = () => {
    const errors = [];
    for (const move of [...moved].reverse()) {
      try {
        const sourceStat = statIfPresent(fileSystem, move.source);
        if (sourceStat) {
          if (
            !move.linked ||
            !sourceStat.isSymbolicLink() ||
            resolve(dirname(move.source), fileSystem.readlinkSync(move.source)) !== move.destination
          ) {
            throw new Error(`Cannot restore resource over a changed path: ${move.source}`);
          }
          fileSystem.unlinkSync(move.source);
        }
        fileSystem.renameSync(move.destination, move.source);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const path of [...createdDirectories].reverse()) {
      try {
        fileSystem.rmdirSync(path);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Failed to restore the original bundle layout.');
    moved.length = 0;
  };

  try {
    for (const move of plan.moves) {
      if (!inside(plan.bundle, move.source) || !inside(plan.bundle, move.destination)) {
        throw new Error('Layout plan leaves the app bundle.');
      }
      checkDestinationParents(plan.bundle, dirname(move.destination), fileSystem);
      if (statIfPresent(fileSystem, move.destination)) {
        throw new Error(`Resource destination appeared during repair: ${move.destination}`);
      }
      makeDirectory(dirname(move.destination));
      fileSystem.renameSync(move.source, move.destination);
      const entry = { ...move, linked: false };
      moved.push(entry);
      fileSystem.symlinkSync(
        relative(dirname(move.source), move.destination),
        move.source,
        move.directory ? 'dir' : 'file',
      );
      entry.linked = true;
    }
    return { rollback };
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Bundle layout repair and rollback failed.');
    }
    throw error;
  }
}
