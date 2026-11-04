import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { maaService, controllerErrorMessage } from '@/services/maaService';
import { buildIosControllerConfig } from '@/utils/iosController';
import type { ControllerItem } from '@/types/interface';
import type { IosDevice } from '@/types/maa';
import { startGlobalCallbackListener, waitForCtrlResult } from './connection';

export function IosDevicePicker({
  controller,
  instanceId,
  disabled,
  onConnectionChange,
}: {
  controller: ControllerItem;
  instanceId: string;
  disabled?: boolean;
  onConnectionChange?: (connected: boolean) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const saved = useAppStore(
    (state) => state.instances.find((instance) => instance.id === instanceId)?.savedDevice?.iosUdid,
  );
  const status = useAppStore((state) => state.instanceConnectionStatus[instanceId]);
  const [udid, setUdid] = useState(controller.ios?.udid || saved || '');
  const [devices, setDevices] = useState<IosDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = status === 'Connected';
  const unavailable = disabled || busy || status === 'Connecting';
  useEffect(() => {
    setUdid(controller.ios?.udid || saved || '');
    setError('');
  }, [controller, saved, instanceId]);
  const discover = async () => {
    setBusy(true);
    setError('');
    try {
      await maaService.init();
      const connection = { Auto: 0, USB: 1, WiFi: 2 }[controller.ios?.connection ?? 'Auto'];
      const found = await maaService.findIosDevices(
        connection,
        JSON.stringify(controller.ios?.config ?? {}),
      );
      setDevices(found);
      if (!udid && found.length === 1) setUdid(found[0].udid);
    } catch (error) {
      setError(controllerErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setError('');
    const store = useAppStore.getState();
    store.setInstanceConnectionStatus(instanceId, 'Connecting');
    try {
      const config = buildIosControllerConfig(controller, udid);
      await maaService.init();
      await maaService.createInstance(instanceId).catch(() => {});
      await startGlobalCallbackListener();
      const id = await maaService.connectController(instanceId, config);
      store.registerCtrlIdName(
        instanceId,
        id,
        devices.find((device) => device.udid === config.udid)?.name || config.udid,
        'device',
      );
      const result = await waitForCtrlResult(id);
      if (result !== 'succeeded') throw new Error(t('controller.connectionFailed'));
      store.setInstanceSavedDevice(instanceId, { iosUdid: config.udid });
      store.setInstanceConnectionStatus(instanceId, 'Connected');
      onConnectionChange?.(true);
    } catch (error) {
      setError(controllerErrorMessage(error));
      store.setInstanceConnectionStatus(instanceId, 'Disconnected');
      onConnectionChange?.(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 gap-2">
        <input
          aria-label={t('pi.iosUdid')}
          list={listId}
          value={udid}
          onChange={(event) => setUdid(event.target.value)}
          placeholder={t('pi.iosUdid')}
          disabled={unavailable || connected || !!controller.ios?.udid}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-sm text-text-primary"
        />
        <datalist id={listId}>
          {devices.map((device) => (
            <option key={device.udid} value={device.udid}>
              {device.name}
            </option>
          ))}
        </datalist>
        <button
          aria-label={t('pi.iosSearch')}
          title={t('pi.iosSearch')}
          disabled={unavailable || connected}
          onClick={() => {
            void discover();
          }}
          className="rounded-md border border-border p-2 text-text-secondary disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
        <button
          disabled={unavailable || connected || !udid.trim()}
          onClick={() => {
            void connect();
          }}
          className="rounded-md bg-accent px-3 text-sm text-white disabled:opacity-50"
        >
          {t(connected ? 'controller.connected' : 'controller.connect')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
