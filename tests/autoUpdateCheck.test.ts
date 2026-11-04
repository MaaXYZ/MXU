import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAutoUpdateCheck } from '../src/services/autoUpdateCheck.ts';
import type { UpdateInfo } from '../src/stores/types.ts';
import type { CheckAndDownloadOptions } from '../src/services/updateService.ts';
import type { ProjectInterface } from '../src/types/interface.ts';

type Dependencies = Parameters<typeof runAutoUpdateCheck>[1];
type CheckState = ReturnType<Dependencies['getState']>;

function createCheck() {
  const project: ProjectInterface = {
    interface_version: 2,
    name: 'Example',
    mirrorchyan_rid: 'example',
    version: 'v1.0.0',
    github: 'https://github.com/example/app',
    controller: [],
    resource: [],
    task: [],
  };
  let state: CheckState = {
    projectInterface: project,
    updateCheckLoading: false,
    setUpdateCheckLoading: (loading) => {
      state = { ...state, updateCheckLoading: loading };
    },
    downloadStatus: 'idle',
    installStatus: 'idle',
    mirrorChyanSettings: { cdk: '', channel: 'stable' },
    proxySettings: undefined,
  };
  let resolve!: (result: UpdateInfo | null) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<UpdateInfo | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const requests: CheckAndDownloadOptions[] = [];
  const results: UpdateInfo[] = [];
  const dependencies: Dependencies = {
    getState: () => state,
    checkAndPrepareDownload: (options) => {
      requests.push(options);
      return pending;
    },
    onResult: (result) => results.push(result),
  };

  return {
    project,
    dependencies,
    requests,
    results,
    resolve,
    reject,
    get state() {
      return state;
    },
    setState(changes: Partial<CheckState>) {
      state = { ...state, ...changes };
    },
  };
}

const update: UpdateInfo = {
  hasUpdate: true,
  versionName: 'v3.0.0',
  releaseNote: 'New release',
  downloadUrl: 'https://example.com/v3.zip',
};

test('overlapping startup and scheduled checks share one request and cannot overwrite its result', async () => {
  const check = createCheck();
  const startup = runAutoUpdateCheck(check.project, check.dependencies);
  assert.equal(check.state.updateCheckLoading, true);

  await runAutoUpdateCheck(check.project, check.dependencies);
  assert.equal(check.requests.length, 1);
  assert.equal(check.state.updateCheckLoading, true);

  check.resolve(update);
  await startup;
  assert.deepEqual(check.results, [update]);
  assert.equal(check.state.updateCheckLoading, false);
});

test('an active manual check keeps ownership of the shared loading state', async () => {
  const check = createCheck();
  check.setState({ updateCheckLoading: true });
  await runAutoUpdateCheck(check.project, check.dependencies);
  assert.equal(check.requests.length, 0);
  assert.equal(check.state.updateCheckLoading, true);
});

test('automatic checks leave active downloads, pending packages and installations alone', async () => {
  for (const status of [
    { downloadStatus: 'downloading' },
    { downloadStatus: 'completed' },
    { installStatus: 'installing' },
    { installStatus: 'completed' },
    { installStatus: 'failed' },
  ] satisfies Partial<CheckState>[]) {
    const check = createCheck();
    check.setState(status);
    await runAutoUpdateCheck(check.project, check.dependencies);
    assert.equal(check.requests.length, 0);
    assert.equal(check.state.updateCheckLoading, false);
  }
});

test('failed and empty responses release the loading state for the next check', async () => {
  const check = createCheck();
  const first = runAutoUpdateCheck(check.project, check.dependencies);
  check.reject(new Error('Network failed'));
  await assert.rejects(first, /Network failed/);
  assert.equal(check.state.updateCheckLoading, false);

  const retry = runAutoUpdateCheck(check.project, {
    ...check.dependencies,
    checkAndPrepareDownload: async () => null,
  });
  await retry;
  assert.equal(check.state.updateCheckLoading, false);
  assert.equal(check.results.length, 0);
});

test('startup and scheduled responses are discarded when their update parameters change', async () => {
  const changes: Partial<CheckState>[] = [
    { mirrorChyanSettings: { cdk: 'new-cdk', channel: 'stable' } },
    { mirrorChyanSettings: { cdk: '', channel: 'beta' } },
    { mirrorChyanSettings: { cdk: '', channel: 'stable', githubPat: 'new-pat' } },
    { proxySettings: { url: 'http://localhost:8080' } },
  ];
  for (const change of changes) {
    const check = createCheck();
    const request = runAutoUpdateCheck(check.project, check.dependencies);
    check.setState(change);
    check.resolve(update);
    await request;
    assert.equal(check.results.length, 0);
    assert.equal(check.state.updateCheckLoading, false);
  }
});

test('replacing the loaded project or starting/completing a download invalidates an in-flight result', async () => {
  for (const change of ['project', 'downloading', 'completed'] as const) {
    const check = createCheck();
    const request = runAutoUpdateCheck(check.project, check.dependencies);
    check.setState(
      change === 'project'
        ? { projectInterface: { ...check.project, version: 'v2.0.0' } }
        : { downloadStatus: change },
    );
    check.resolve(update);
    await request;
    assert.equal(check.results.length, 0);
    assert.equal(check.state.updateCheckLoading, false);
  }
});

test('cancelling a scheduled check discards its eventual result', async () => {
  const check = createCheck();
  let cancelled = false;
  const request = runAutoUpdateCheck(check.project, {
    ...check.dependencies,
    isCancelled: () => cancelled,
  });
  cancelled = true;
  check.resolve(update);
  await request;
  assert.equal(check.results.length, 0);
  assert.equal(check.state.updateCheckLoading, false);
});

test('equivalent settings synchronized from another client still allow the result', async () => {
  const check = createCheck();
  const request = runAutoUpdateCheck(check.project, check.dependencies);
  check.setState({
    projectInterface: { ...check.project },
    mirrorChyanSettings: { ...check.state.mirrorChyanSettings },
  });
  check.resolve(update);
  await request;
  assert.deepEqual(check.results, [update]);
});
