import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import type { BuiltinSkinId } from '@/skins/types';
import deepseekArt from '@/assets/skins/deepseek.png';
import deepseekCalm from '@/assets/skins/deepseek-calm.png';
import deepseekError from '@/assets/skins/deepseek-error.png';
import deepseekClip from '@/assets/skins/deepseek-eat.mp4';
import naiwaCalm from '@/assets/skins/naiwa-calm.png';
import naiwaStill from '@/assets/skins/naiwa-still.webp';
import naiwaClip from '@/assets/skins/naiwa-laugh.mp4';
import { getSkinTaskState } from './state';
import './skins.css';

const INTERACTION_MS = 2400;

function useSkinMotion() {
  const [systemReduced, setSystemReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setSystemReduced(media.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    const hide = () => setPageVisible(false);
    updateMotion();
    media.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', updateVisibility);
    return () => {
      media.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', updateVisibility);
    };
  }, []);
  return { systemReduced, pageVisible };
}

/** Trusted, bundled companions only. This is not a third-party skin renderer. */
export function BuiltinSkinCompanion({ preview = false }: { preview?: boolean }) {
  const skinId = useAppStore((state) => state.skinId);
  const instanceId = useAppStore((state) => state.activeInstanceId);
  if (skinId === 'default') return null;
  return (
    <SkinScene
      key={`${skinId}:${preview ? 'preview' : instanceId}`}
      skinId={skinId}
      preview={preview}
    />
  );
}

function SkinScene({
  skinId,
  preview,
}: {
  skinId: Exclude<BuiltinSkinId, 'default'>;
  preview: boolean;
}) {
  const { t } = useTranslation();
  const { activeInstanceId, isRunning, status, userReduced } = useAppStore(
    useShallow((state) => ({
      activeInstanceId: state.activeInstanceId,
      isRunning: !!state.instances.find((instance) => instance.id === state.activeInstanceId)
        ?.isRunning,
      status: state.activeInstanceId ? state.instanceTaskStatus[state.activeInstanceId] : null,
      userReduced: state.skinReducedMotion,
    })),
  );
  const taskState = preview ? 'idle' : getSkinTaskState(isRunning, status);
  const { systemReduced, pageVisible } = useSkinMotion();
  const reduced = userReduced || systemReduced;
  const [interacting, setInteracting] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionRevision = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRevision = useRef(0);
  const wantsPlayback = useRef(false);
  const interactionAllowed = taskState === 'idle' || taskState === 'running';
  const hasInteraction = interacting && interactionAllowed;
  const laughing = skinId === 'naiwa' && (hasInteraction || taskState === 'success');
  const eating =
    skinId === 'deepseek' && (hasInteraction || taskState === 'running' || taskState === 'success');
  const performing = (laughing || eating) && !reduced && pageVisible && !videoFailed;
  wantsPlayback.current = performing;

  // Instance changes and terminal results retire the old interaction without changing any task.
  useEffect(() => {
    setInteracting(false);
    interactionRevision.current++;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    return () => {
      interactionRevision.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [activeInstanceId, taskState, pageVisible]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const revision = ++playbackRevision.current;
    video.muted = true;
    video.defaultMuted = true;
    if (performing) {
      try {
        const result = video.play();
        result?.then(
          () => {
            if (
              !video.isConnected ||
              (revision !== playbackRevision.current && !wantsPlayback.current)
            )
              video.pause();
          },
          () => {
            if (revision === playbackRevision.current) setVideoFailed(true);
          },
        );
      } catch {
        setVideoFailed(true);
      }
    } else {
      video.pause();
      if (taskState === 'idle' || taskState === 'error' || !pageVisible) video.currentTime = 0;
    }
    return () => {
      playbackRevision.current++;
      video.pause();
    };
  }, [performing, activeInstanceId, taskState, pageVisible]);

  function interact() {
    if (!interactionAllowed) return;
    if (timer.current !== null) clearTimeout(timer.current);
    const revision = ++interactionRevision.current;
    setInteracting(true);
    timer.current = setTimeout(() => {
      if (revision !== interactionRevision.current) return;
      timer.current = null;
      setInteracting(false);
    }, INTERACTION_MS);
  }

  const deepseekPose = taskState === 'error' ? deepseekError : eating ? deepseekArt : deepseekCalm;

  return (
    <section
      className={`builtin-skin builtin-skin--${skinId}${preview ? ' builtin-skin--preview' : ''}`}
      aria-label={t('skin.regionLabel')}
      data-builtin-skin={skinId}
      data-task-state={taskState}
      data-reduced-motion={reduced}
    >
      <div className={`builtin-skin__art builtin-skin__art--${skinId}`} aria-hidden="true">
        <img
          src={skinId === 'deepseek' ? deepseekPose : laughing ? naiwaStill : naiwaCalm}
          alt=""
          draggable={false}
        />
        <video
          ref={videoRef}
          src={skinId === 'naiwa' ? naiwaClip : deepseekClip}
          poster={skinId === 'naiwa' ? naiwaStill : deepseekPose}
          className={performing ? 'builtin-skin__video is-playing' : 'builtin-skin__video'}
          muted
          loop
          playsInline
          preload="metadata"
          onError={() => setVideoFailed(true)}
        />
      </div>
      <div className="builtin-skin__copy">
        <div className="builtin-skin__heading">
          <strong>
            {t(skinId === 'deepseek' ? 'settings.skinDeepseek' : 'settings.skinNaiwa')}
          </strong>
          <span role="status" aria-live="polite">
            {t(`skin.state.${taskState}`)}
          </span>
        </div>
        {reduced && <small>{t('skin.reducedMotion')}</small>}
      </div>
      <button
        type="button"
        className="builtin-skin__interact"
        onClick={interact}
        aria-pressed={hasInteraction}
        disabled={!interactionAllowed}
      >
        {t(skinId === 'deepseek' ? 'skin.feed' : 'skin.poke')}
      </button>
    </section>
  );
}
