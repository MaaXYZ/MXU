import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { maaService } from '@/services/maaService';
import { useAppStore } from '@/stores/appStore';
import type { AdbDevice, Win32Window, ControllerConfig } from '@/types/maa';
import type { ControllerItem } from '@/types/interface';
import {
  buildDesktopWindowControllerConfig,
  getDesktopWindowFilters,
  isDesktopWindowControllerType,
} from '@/utils/controller';
import { buildPlayCoverControllerConfig } from '@/utils/playCoverController';
import { startGlobalCallbackListener, waitForCtrlResult } from './callbackCache';

interface UseDeviceConnectionProps {
  instanceId: string;
  currentController: ControllerItem | undefined;
  controllerType: ControllerItem['type'] | undefined;
}

export function useDeviceConnection({
  instanceId,
  currentController,
  controllerType,
}: UseDeviceConnectionProps) {
  const { t } = useTranslation();
  const {
    cachedAdbDevices,
    cachedWin32Windows,
    cachedWlrootsSockets,
    setCachedAdbDevices,
    setCachedWin32Windows,
    setCachedWlrootsSockets,
    setInstanceConnectionStatus,
    setInstanceResourceLoaded,
    setInstanceSavedDevice,
    registerCtrlIdName,
    instances,
  } = useAppStore();

  const activeInstance = instances.find((i) => i.id === instanceId);

  const [isSearching, setIsSearching] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [selectedAdbDevice, setSelectedAdbDevice] = useState<AdbDevice | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<Win32Window | null>(null);
  const [selectedWlrootsSocket, setSelectedWlrootsSocket] = useState<string | null>(null);
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const [playcoverAddress, setPlaycoverAddress] = useState(
    activeInstance?.savedDevice?.playcoverAddress || '127.0.0.1:1717',
  );
  const isDesktopWindowController = isDesktopWindowControllerType(controllerType);
  const { classRegex: desktopWindowClassRegex, titleRegex: desktopWindowTitleRegex } =
    getDesktopWindowFilters(currentController);

  const deviceDropdownRef = useRef<HTMLButtonElement>(null);
  const deviceMenuRef = useRef<HTMLDivElement>(null);

  // 初始化 MaaFramework
  const ensureMaaInitialized = async () => {
    try {
      await maaService.getVersion();
      return true;
    } catch {
      await maaService.init();
      return true;
    }
  };

  // 连接控制器的内部实现
  const connectControllerInternal = useCallback(
    async (config: ControllerConfig, deviceName: string, targetType: 'device' | 'window') => {
      await startGlobalCallbackListener();
      const ctrlId = await maaService.connectController(instanceId, config);

      registerCtrlIdName(instanceId, ctrlId, deviceName || '', targetType);

      const result = await waitForCtrlResult(ctrlId);

      if (result === 'succeeded') {
        setIsConnected(true);
        setInstanceConnectionStatus(instanceId, 'Connected');
        setIsConnecting(false);
        return true;
      } else {
        setDeviceError(t('controller.connectionFailed'));
        setIsConnected(false);
        setInstanceConnectionStatus(instanceId, 'Disconnected');
        setIsConnecting(false);
        return false;
      }
    },
    [instanceId, registerCtrlIdName, setInstanceConnectionStatus, t],
  );

  // 搜索设备
  const handleSearch = useCallback(async () => {
    if (!currentController) return;

    setIsSearching(true);
    setDeviceError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      const savedDevice = activeInstance?.savedDevice;

      if (controllerType === 'Adb') {
        const devices = await maaService.findAdbDevices();
        setCachedAdbDevices(devices);

        let autoSelected: AdbDevice | null = null;
        if (savedDevice?.adbDeviceName) {
          const matched = devices.filter((d) => d.name === savedDevice.adbDeviceName);
          if (matched.length === 1) {
            autoSelected = matched[0];
          }
        } else if (devices.length > 0) {
          autoSelected = devices[0];
        }

        if (autoSelected) {
          handleSelectAdbDevice(autoSelected);
        } else if (devices.length > 0) {
          setShowDeviceDropdown(true);
        }
      } else if (isDesktopWindowController) {
        const windows = await maaService.findWin32Windows(
          desktopWindowClassRegex,
          desktopWindowTitleRegex,
        );
        setCachedWin32Windows(windows);

        let autoSelected: Win32Window | null = null;
        if (savedDevice?.windowName) {
          const matched = windows.filter((w) => w.window_name === savedDevice.windowName);
          if (matched.length === 1) {
            autoSelected = matched[0];
          }
        } else if (windows.length > 0) {
          autoSelected = windows[0];
        }

        if (autoSelected) {
          handleSelectWindow(autoSelected);
        } else if (windows.length > 0) {
          setShowDeviceDropdown(true);
        }
      } else if (controllerType === 'WlRoots') {
        const sockets = await maaService.findWlrootsSockets();
        setCachedWlrootsSockets(sockets);

        let autoSelected: string | null = null;
        if (savedDevice?.wlrSocketPath) {
          const matched = sockets.filter((s) => s === savedDevice.wlrSocketPath);
          if (matched.length === 1) {
            autoSelected = matched[0];
          }
        } else if (sockets.length > 0) {
          autoSelected = sockets[0];
        }

        if (autoSelected) {
          handleSelectWlrootsSocket(autoSelected);
        } else if (sockets.length > 0) {
          setShowDeviceDropdown(true);
        }
      }
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
    } finally {
      setIsSearching(false);
    }
  }, [
    currentController,
    controllerType,
    activeInstance?.savedDevice,
    isDesktopWindowController,
    desktopWindowClassRegex,
    desktopWindowTitleRegex,
    setCachedAdbDevices,
    setCachedWin32Windows,
    setCachedWlrootsSockets,
    t,
  ]);

  // 选择 ADB 设备并自动连接
  const handleSelectAdbDevice = useCallback(
    async (device: AdbDevice) => {
      setSelectedAdbDevice(device);
      setShowDeviceDropdown(false);

      setInstanceSavedDevice(instanceId, { adbDeviceName: device.name });

      setIsConnecting(true);
      setDeviceError(null);

      try {
        if (isConnected) {
          await maaService.destroyInstance(instanceId).catch(() => {});
          setIsConnected(false);
          setInstanceResourceLoaded(instanceId, false);
        }

        const initialized = await ensureMaaInitialized();
        if (!initialized) {
          throw new Error(t('maa.initFailed'));
        }

        await maaService.createInstance(instanceId).catch(() => {});

        const config: ControllerConfig = {
          type: 'Adb',
          adb_path: device.adb_path,
          address: device.address,
          screencap_methods: device.screencap_methods,
          input_methods: device.input_methods,
          config: device.config,
          display_short_side: currentController?.display_short_side,
        };

        await connectControllerInternal(config, device.name || device.address, 'device');
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
        setIsConnected(false);
        setInstanceConnectionStatus(instanceId, 'Disconnected');
        setIsConnecting(false);
      }
    },
    [
      instanceId,
      isConnected,
      setInstanceSavedDevice,
      setInstanceConnectionStatus,
      setInstanceResourceLoaded,
      connectControllerInternal,
      t,
    ],
  );

  // 选择桌面窗口并自动连接
  const handleSelectWindow = useCallback(
    async (win: Win32Window) => {
      setSelectedWindow(win);
      setShowDeviceDropdown(false);

      setInstanceSavedDevice(instanceId, { windowName: win.window_name });

      setIsConnecting(true);
      setDeviceError(null);

      try {
        if (isConnected) {
          await maaService.destroyInstance(instanceId).catch(() => {});
          setIsConnected(false);
          setInstanceResourceLoaded(instanceId, false);
        }

        const initialized = await ensureMaaInitialized();
        if (!initialized) {
          throw new Error(t('maa.initFailed'));
        }

        await maaService.createInstance(instanceId).catch(() => {});

        const config = buildDesktopWindowControllerConfig(currentController, win.handle);
        if (!config) {
          throw new Error(t('controller.selectWindow'));
        }

        await connectControllerInternal(config, win.window_name || win.class_name, 'window');
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
        setIsConnected(false);
        setInstanceConnectionStatus(instanceId, 'Disconnected');
        setIsConnecting(false);
      }
    },
    [
      instanceId,
      isConnected,
      controllerType,
      currentController,
      setInstanceSavedDevice,
      setInstanceConnectionStatus,
      setInstanceResourceLoaded,
      connectControllerInternal,
      t,
    ],
  );

  // 选择 WlRoots socket 并自动连接
  const handleSelectWlrootsSocket = useCallback(
    async (socketPath: string) => {
      setSelectedWlrootsSocket(socketPath);
      setShowDeviceDropdown(false);

      setInstanceSavedDevice(instanceId, { wlrSocketPath: socketPath });

      setIsConnecting(true);
      setDeviceError(null);

      try {
        if (isConnected) {
          await maaService.destroyInstance(instanceId).catch(() => {});
          setIsConnected(false);
          setInstanceResourceLoaded(instanceId, false);
        }

        const initialized = await ensureMaaInitialized();
        if (!initialized) {
          throw new Error(t('maa.initFailed'));
        }

        await maaService.createInstance(instanceId).catch(() => {});

        const config: ControllerConfig = {
          type: 'WlRoots',
          wlr_socket_path: socketPath,
          use_win32_vk_code: currentController?.wlroots?.use_win32_vk_code ?? false,
        };

        await connectControllerInternal(config, socketPath, 'device');
      } catch (err) {
        setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
        setIsConnected(false);
        setInstanceConnectionStatus(instanceId, 'Disconnected');
        setIsConnecting(false);
      }
    },
    [
      instanceId,
      isConnected,
      setInstanceSavedDevice,
      setInstanceConnectionStatus,
      setInstanceResourceLoaded,
      connectControllerInternal,
      t,
    ],
  );

  // PlayCover 连接
  const handleConnectPlayCover = useCallback(async () => {
    setIsConnecting(true);
    setDeviceError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      setInstanceSavedDevice(instanceId, { playcoverAddress });

      const config: ControllerConfig = buildPlayCoverControllerConfig(
        playcoverAddress,
        currentController?.playcover?.uuid,
        currentController?.display_short_side,
      );

      await connectControllerInternal(config, playcoverAddress, 'device');
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  }, [
    instanceId,
    playcoverAddress,
    currentController?.playcover?.uuid,
    setInstanceSavedDevice,
    setInstanceConnectionStatus,
    connectControllerInternal,
    t,
  ]);

  // 获取选中设备的显示文本
  const getSelectedDeviceText = useCallback(() => {
    const savedDevice = activeInstance?.savedDevice;

    if (controllerType === 'Adb') {
      if (selectedAdbDevice) {
        return `${selectedAdbDevice.name} (${selectedAdbDevice.address})`;
      }
      if (savedDevice?.adbDeviceName) {
        return savedDevice.adbDeviceName;
      }
      return t('controller.selectDevice');
    }
    if (isDesktopWindowController) {
      if (selectedWindow) {
        return selectedWindow.window_name || selectedWindow.class_name;
      }
      if (savedDevice?.windowName) {
        return savedDevice.windowName;
      }
      return t('controller.selectWindow');
    }
    if (controllerType === 'WlRoots') {
      if (selectedWlrootsSocket) {
        return selectedWlrootsSocket;
      }
      if (savedDevice?.wlrSocketPath) {
        return savedDevice.wlrSocketPath;
      }
      return t('controller.selectDevice');
    }
    return t('controller.selectDevice');
  }, [
    controllerType,
    isDesktopWindowController,
    selectedAdbDevice,
    selectedWindow,
    selectedWlrootsSocket,
    activeInstance?.savedDevice,
    t,
  ]);

  // 判断是否可以连接
  const canConnect = useCallback(() => {
    if (controllerType === 'Adb') return !!selectedAdbDevice;
    if (isDesktopWindowController) return !!selectedWindow;
    if (controllerType === 'WlRoots') return !!selectedWlrootsSocket;
    if (controllerType === 'PlayCover') return playcoverAddress.trim().length > 0;
    return false;
  }, [
    controllerType,
    isDesktopWindowController,
    selectedAdbDevice,
    selectedWindow,
    selectedWlrootsSocket,
    playcoverAddress,
  ]);

  return {
    // 状态
    isSearching,
    isConnecting,
    isConnected,
    deviceError,
    selectedAdbDevice,
    selectedWindow,
    showDeviceDropdown,
    playcoverAddress,
    cachedAdbDevices,
    cachedWin32Windows,
    cachedWlrootsSockets,
    // Refs
    deviceDropdownRef,
    deviceMenuRef,
    // Setters
    setIsConnected,
    setIsConnecting,
    setDeviceError,
    setSelectedAdbDevice,
    setSelectedWindow,
    setShowDeviceDropdown,
    setPlaycoverAddress,
    // Actions
    handleSearch,
    handleSelectAdbDevice,
    handleSelectWindow,
    handleConnectPlayCover,
    getSelectedDeviceText,
    canConnect,
    ensureMaaInitialized,
    connectControllerInternal,
  };
}
