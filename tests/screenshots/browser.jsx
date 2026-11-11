import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { DashboardView } from '@/components/DashboardView';
import { ScreenshotPanel } from '@/components/ScreenshotPanel';
import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import i18n from '@/i18n';

const id = 'dashboard-fixture';
const root = createRoot(document.getElementById('root'));
const render = (element) => flushSync(() => root.render(element));
const results = [];
const check = (name, actual) => results.push({ name, passed: Boolean(actual) });
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await settle(20);
}
const button = (key) =>
  [...document.querySelectorAll('button')].find((el) => el.title === i18n.t(key));
const screenshot = () => document.querySelector('img[alt="Screenshot"]')?.getAttribute('src');
const pixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

async function probe() {
  // The fixture blocks all network access, even if a new code path misses a mock.
  window.fetch = async () => {
    throw Error('Unexpected network access in screenshot fixture');
  };
  let oldFrame = deferred();
  let lateSubscribe = deferred();
  const leases = new Map();
  let delaySubscription = false;
  let subscriptions = 0,
    removals = 0,
    reads = 0;
  let holdFrame = false,
    currentFrame = pixel,
    failReads = 0;
  Object.assign(maaService, {
    screenshotSubscribe: async (_instance, subscriber) => {
      subscriptions++;
      if (delaySubscription) {
        delaySubscription = false;
        await lateSubscribe.promise;
      }
      leases.set(subscriber, Date.now());
    },
    screenshotUnsubscribe: async (_instance, subscriber) => {
      removals++;
      leases.delete(subscriber);
    },
    getCachedImage: async () => {
      reads++;
      if (failReads > 0) {
        failReads--;
        throw Error('fixture read failure');
      }
      return holdFrame ? oldFrame.promise : currentFrame;
    },
    isRunning: async () => false,
    onCallback: async () => () => {},
  });
  useAppStore.setState({
    activeInstanceId: id,
    projectInterface: {
      name: 'Fixture',
      controller: [{ name: 'adb', type: 'Adb' }],
      resource: [{ name: 'r' }],
      task: [{ name: 'task', entry: 'entry' }],
    },
    instances: [
      {
        id,
        name: 'Fixture',
        isRunning: true,
        selectedTasks: [{ id: 'task-1', enabled: true, taskName: 'task', optionValues: {} }],
      },
    ],
    instanceConnectionStatus: { [id]: 'Connected' },
    instanceResourceLoaded: { [id]: true },
    instanceTaskStatus: { [id]: 'Running' },
    screenshotFrameRate: '5',
  });
  render(<DashboardView />);
  await waitFor(() => button('taskList.stopTasks') && screenshot() === pixel);
  check(
    'connected card shows Stop and a live frame',
    button('taskList.stopTasks') && screenshot() === pixel,
  );
  // Hold a frame in flight from this connection until its replacement has painted.
  holdFrame = true;
  const previousReads = reads;
  for (let i = 0; i < 12 && reads === previousReads; i++) await settle();
  check('old capture is in flight before disconnect', reads > previousReads);
  const removedBeforeDisconnect = removals;
  const subscribedBeforeDisconnect = subscriptions;
  useAppStore.getState().setInstanceConnectionStatus(id, 'Disconnected');
  await settle();
  check('disconnected active run still has a Stop control', button('taskList.stopTasks'));
  check(
    'disconnect releases subscription and clears frame',
    removals === removedBeforeDisconnect + 1 && !screenshot(),
  );
  useAppStore.getState().updateInstance(id, { isRunning: false });
  await settle();
  check('disconnected idle card cannot start tasks', !button('taskList.startTasks'));
  useAppStore.getState().setInstanceResourceLoaded(id, false);
  holdFrame = false;
  currentFrame = pixel + '#new';
  useAppStore.getState().setInstanceConnectionStatus(id, 'Connected');
  await settle();
  check('connection waits for resource before enabling Start', !button('taskList.startTasks'));
  check(
    'new connection subscribes and paints independently',
    subscriptions === subscribedBeforeDisconnect + 1 && screenshot() === currentFrame,
  );
  const staleDashboardFrame = oldFrame;
  oldFrame = deferred();
  holdFrame = true;
  staleDashboardFrame.resolve(pixel + '#stale');
  await settle();
  check('old frame cannot replace the new connection frame', screenshot() === currentFrame);
  holdFrame = false;
  oldFrame.resolve(currentFrame);
  useAppStore.getState().setInstanceResourceLoaded(id, true);
  await settle();
  check(
    'resource restoration enables Start',
    button('taskList.startTasks') && !button('taskList.startTasks').disabled,
  );

  // Chromium advances virtual time. Backend TTL is 30s, including at the slowest frame rate.
  useAppStore.setState({ screenshotFrameRate: '0.033' });
  await settle();
  const leaseIsLive = () => leases.size === 1 && Date.now() - [...leases.values()][0] < 30_000;
  await settle(35_000);
  check('30s frame rate Dashboard keeps its lease beyond backend TTL', leaseIsLive());

  // Two independently mounted cards for the same instance must own distinct subscriptions.
  render(
    <>
      <DashboardView key="one" />
      <DashboardView key="two" />
    </>,
  );
  await settle();
  check('simultaneous Dashboard views hold independent subscriptions', leases.size === 2);
  render(
    <>
      <DashboardView key="one" />
    </>,
  );
  await settle();
  check('closing one view leaves the other subscribed', leaseIsLive());

  delaySubscription = true;
  useAppStore.setState({ screenshotFrameRate: '5' });
  await settle();
  useAppStore.setState({ screenshotFrameRate: '0.033' });
  await settle();
  lateSubscribe.resolve();
  await settle();
  check('late subscribe acknowledgement cannot leak or remove the newer lease', leaseIsLive());

  lateSubscribe = deferred();
  delaySubscription = true;
  useAppStore.setState({ screenshotFrameRate: '5' });
  await settle();
  render(null);
  await settle();
  lateSubscribe.resolve();
  await settle();
  const unmountedCount = subscriptions;
  await settle(12_000);
  check(
    'unmounted Dashboard releases a late acknowledgement and does not renew',
    leases.size === 0 && subscriptions === unmountedCount,
  );
  // The panel below represents a fresh backend session.
  leases.clear();
  useAppStore.setState({
    instanceResourceLoaded: { [id]: false },
    sidePanelExpanded: true,
    screenshotPanelExpanded: true,
    screenshotFrameRate: '0.033',
  });
  render(<ScreenshotPanel />);
  await settle();
  await settle(35_000);
  check('expanded screenshot panel renews beyond backend TTL', leaseIsLive());
  oldFrame = deferred();
  holdFrame = true;
  // The next capture is due in 25s at the slowest rate.
  await settle(26_000);
  useAppStore.getState().setInstanceConnectionStatus(id, 'Disconnected');
  await settle();
  holdFrame = false;
  currentFrame = pixel + '#panel-reconnected';
  useAppStore.getState().setInstanceConnectionStatus(id, 'Connected');
  await settle();
  check(
    'reconnected screenshot panel paints before the old capture returns',
    screenshot() === currentFrame,
  );
  const stalePanelFrame = oldFrame;
  oldFrame = deferred();
  holdFrame = true;
  stalePanelFrame.resolve(pixel + '#stale-panel');
  await settle();
  check('old capture cannot change a reconnected screenshot panel', screenshot() === currentFrame);
  holdFrame = false;
  oldFrame.resolve(currentFrame);
  // A tab switch must transfer the frame loop without waiting for the old 30s timer.
  const other = 'dashboard-fixture-other';
  currentFrame = pixel + '#panel-other';
  useAppStore.setState({
    activeInstanceId: other,
    instanceConnectionStatus: { [id]: 'Connected', [other]: 'Connected' },
    instanceScreenshotStreaming: { [id]: true, [other]: true },
  });
  await settle();
  check(
    'switching instances starts the selected screenshot panel immediately',
    screenshot() === currentFrame,
  );
  useAppStore.getState().setScreenshotPanelExpanded(false);
  await settle();
  const foldedCount = subscriptions;
  const foldedReads = reads;
  await settle(31_000);
  check(
    'folded screenshot panel releases its lease and stops renewing',
    leases.size === 0 && subscriptions === foldedCount,
  );
  check('folding prevents an old timer from reading another screenshot', reads === foldedReads);
  useAppStore.setState({
    screenshotFrameRate: '5',
    screenshotPanelExpanded: true,
  });
  await settle();
  button('screenshot.stopStream')?.click();
  await settle();
  const pausedReads = reads;
  await settle(11_000);
  check(
    'manual panel pause keeps the screenshot and suspends reads and subscription',
    leases.size === 0 &&
      reads === pausedReads &&
      screenshot() === currentFrame &&
      button('screenshot.startStream'),
  );
  failReads = 19;
  button('screenshot.startStream')?.click();
  await settle(4100);
  check(
    'a successful panel capture after 19 failures keeps streaming',
    failReads === 0 && button('screenshot.stopStream'),
  );
  failReads = 20;
  await settle(4200);
  check(
    '20 consecutive panel failures stop capture and release the lease',
    failReads === 0 && button('screenshot.startStream') && leases.size === 0,
  );
  // A pause belongs to its instance; another tab's active stream must survive.
  useAppStore.setState({ activeInstanceId: id });
  await settle();
  check('returning to a streaming tab resumes immediately', leaseIsLive());
  useAppStore.setState({ activeInstanceId: other });
  await settle();
  check(
    'switching to a paused tab preserves its pause',
    leases.size === 0 && button('screenshot.startStream'),
  );
  useAppStore.setState({ activeInstanceId: id });
  await settle();
  check("a paused tab does not clear another tab's streaming state", leaseIsLive());
}

probe()
  .catch((error) => results.push({ name: String(error.stack || error), passed: false }))
  .finally(() => {
    root.unmount();
    document.getElementById('result').textContent = btoa(JSON.stringify(results));
  });
