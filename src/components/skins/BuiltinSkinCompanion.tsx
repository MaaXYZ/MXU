import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import type { BuiltinSkinId } from '@/skins/types';
import deepseekArt from '@/assets/skins/deepseek.png';
import deepseekCalm from '@/assets/skins/deepseek-calm.png';
import deepseekError from '@/assets/skins/deepseek-error.png';
import deepseekClip from '@/assets/skins/deepseek-eat.mp4';
import naiwaCalm from '@/assets/skins/naiwa-idle.webp';
import naiwaStill from '@/assets/skins/naiwa-grin.webp';
import naiwaClip from '@/assets/skins/naiwa-laugh.mp4';
import gugugagaIdle from '@/assets/skins/gugugaga-idle.webp';
import gugugagaCheer from '@/assets/skins/gugugaga-cheer.webp';
import gugugagaLaugh from '@/assets/skins/gugugaga-laugh.webp';
import gugugagaSad from '@/assets/skins/gugugaga-sad.webp';
import { getSkinTaskState } from './state';
import { useSkinMotion } from './useSkinMotion';
import './skins.css';

const INTERACTION_MS = 2400;

const SKIN_LABEL_KEYS = {
  deepseek: 'settings.skinDeepseek',
  naiwa: 'settings.skinNaiwa',
  gugugaga: 'settings.skinGugugaga',
} as const;

const INTERACTION_KEYS = {
  deepseek: 'skin.feed',
  naiwa: 'skin.poke',
  gugugaga: 'skin.cheer',
} as const;

const GUGUGAGA_POSES = {
  idle: gugugagaIdle,
  running: gugugagaCheer,
  success: gugugagaLaugh,
  error: gugugagaSad,
} as const;

/** Trusted, bundled companions only. This is not a third-party skin renderer. */
export function BuiltinSkinCompanion({ preview = false }: { preview?: boolean }) {
  const skinId = useAppStore((state) => state.skinId);
  const instanceId = useAppStore((state) => state.activeInstanceId);
  if (skinId === 'default' || (!preview && skinId === 'gugugaga')) return null;
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
  const hasInteraction = interacting && interactionAllowed && pageVisible;
  const laughing = skinId === 'naiwa' && (hasInteraction || taskState === 'success');
  const eating =
    skinId === 'deepseek' && (hasInteraction || taskState === 'running' || taskState === 'success');
  const performing = (eating || laughing) && !reduced && pageVisible && !videoFailed;
  const clip = skinId === 'naiwa' ? naiwaClip : skinId === 'deepseek' ? deepseekClip : null;
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
  const naiwaPose = laughing ? naiwaStill : naiwaCalm;
  const pose =
    skinId === 'deepseek'
      ? deepseekPose
      : skinId === 'naiwa'
        ? naiwaPose
        : GUGUGAGA_POSES[hasInteraction ? 'running' : taskState];

  const stateAttributes = {
    'data-builtin-skin': skinId,
    'data-task-state': taskState,
    'data-reduced-motion': reduced,
    'data-scene-motion': !pageVisible ? 'paused' : reduced ? 'reduced' : 'full',
    'data-interacting': hasInteraction,
    'data-performing': performing,
  };

  const art = (
    <span className={`builtin-skin__art builtin-skin__art--${skinId}`} aria-hidden="true">
      <img src={pose} alt="" draggable={false} />
      {clip && (
        <video
          ref={videoRef}
          src={clip}
          poster={pose}
          className={performing ? 'builtin-skin__video is-playing' : 'builtin-skin__video'}
          muted
          loop
          playsInline
          preload="none"
          onError={() => setVideoFailed(true)}
        />
      )}
    </span>
  );
  const action = t(INTERACTION_KEYS[skinId]);
  if (!preview) {
    return (
      <button
        type="button"
        data-skin-slot="companion"
        className="builtin-skin__avatar"
        {...stateAttributes}
        aria-label={action}
        title={action}
        aria-pressed={hasInteraction}
        disabled={!interactionAllowed}
        onClick={interact}
      >
        {art}
      </button>
    );
  }

  return (
    <section
      className={`builtin-skin--preview builtin-skin--${skinId}`}
      aria-label={t('skin.regionLabel')}
      {...stateAttributes}
    >
      <div className="builtin-skin__copy">
        {skinId === 'gugugaga' && (
          <div className="builtin-skin__eyebrow">{t(SKIN_LABEL_KEYS[skinId])}</div>
        )}
        <h2>{t(skinId === 'gugugaga' ? 'skin.gugugagaScene' : SKIN_LABEL_KEYS[skinId])}</h2>
        <span>{t(`skin.state.${taskState}`)}</span>
        {reduced && <small>{t('skin.reducedMotion')}</small>}
      </div>
      <div className="builtin-skin__stage">
        <span className="builtin-skin__plinth" aria-hidden="true" />
        {art}
      </div>
      <button
        type="button"
        className="builtin-skin__interact"
        onClick={interact}
        aria-pressed={hasInteraction}
      >
        {skinId === 'gugugaga' && <span aria-hidden="true">▷</span>}
        {action}
      </button>
    </section>
  );
}
