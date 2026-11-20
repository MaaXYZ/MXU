import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useAnchoredPanelPosition } from '@/hooks/useAnchoredPanelPosition';
import type { BuiltinSkinId } from '@/skins/types';
import deepseekArt from '@/assets/skins/deepseek.png';
import deepseekCalm from '@/assets/skins/deepseek-calm.png';
import deepseekError from '@/assets/skins/deepseek-error.png';
import deepseekClip from '@/assets/skins/deepseek-eat.mp4';
import naiwaCalm from '@/assets/skins/naiwa-calm.png';
import naiwaStill from '@/assets/skins/naiwa-still.webp';
import naiwaClip from '@/assets/skins/naiwa-laugh.mp4';
import gugugagaIdle from '@/assets/skins/gugugaga-idle.webp';
import gugugagaCheer from '@/assets/skins/gugugaga-cheer.webp';
import { selectSkinTaskState, type SkinTaskState } from './state';
import { useSkinMotion } from './useSkinMotion';
import './skins.css';

const INTERACTION_MS = 2400;

const SKIN_LABEL_KEYS = {
  deepseek: 'settings.skinDeepseek',
  naiwa: 'settings.skinNaiwa',
  gugugaga: 'settings.skinGugugaga',
} as const;

type CompanionSkin = Exclude<BuiltinSkinId, 'default'>;

const COMPANION_ASSETS: Record<
  CompanionSkin,
  {
    idle: string;
    interaction: string;
    clip?: string;
    states?: Partial<Record<SkinTaskState, string>>;
  }
> = {
  deepseek: {
    idle: deepseekArt,
    interaction: deepseekArt,
    clip: deepseekClip,
    states: { running: deepseekCalm, error: deepseekError },
  },
  naiwa: {
    idle: naiwaCalm,
    interaction: naiwaStill,
    clip: naiwaClip,
    states: { success: naiwaStill },
  },
  gugugaga: { idle: gugugagaIdle, interaction: gugugagaCheer },
};

/** The appearance settings preview the bundled character and its interaction. */
export function BuiltinSkinCompanion() {
  const skinId = useAppStore((state) => state.skinId);
  if (skinId === 'default') return null;
  return <CompanionScene key={skinId} skinId={skinId} />;
}

export function WorkspaceSkinCompanion() {
  const skinId = useAppStore((state) => state.skinId);
  if (skinId !== 'deepseek' && skinId !== 'naiwa') return null;
  return <CompanionPopover key={skinId} skinId={skinId} />;
}

function CompanionPopover({ skinId }: { skinId: 'deepseek' | 'naiwa' }) {
  const { t } = useTranslation();
  const id = useId();
  const taskState = useAppStore(selectSkinTaskState);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPanelPosition(anchorRef, panelRef, open);
  const { idle, states } = COMPANION_ASSETS[skinId];
  const label = t(SKIN_LABEL_KEYS[skinId]);

  useLayoutEffect(() => {
    if (open) panelRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    anchorRef.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-skin-slot="companion-trigger"
        className="skin-companion-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={states?.[taskState] ?? idle} alt="" draggable={false} />
      </button>
      {open && (
        <div
          id={id}
          ref={panelRef}
          role="dialog"
          aria-label={label}
          data-skin-slot="companion-panel"
          className="mxu-overlay-surface skin-companion-panel"
          style={position}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            closeAndFocusTrigger();
          }}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              event.relatedTarget !== anchorRef.current
            ) {
              setOpen(false);
            }
          }}
        >
          <CompanionScene skinId={skinId} taskState={taskState} view="workspace" />
          <button
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            className="skin-companion-panel__close"
            onClick={closeAndFocusTrigger}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

function CompanionScene({
  skinId,
  taskState = 'idle',
  view = 'preview',
}: {
  skinId: CompanionSkin;
  taskState?: SkinTaskState;
  view?: 'preview' | 'workspace';
}) {
  const { t } = useTranslation();
  const userReduced = useAppStore((state) => state.skinReducedMotion);
  const { systemReduced, pageVisible } = useSkinMotion();
  const reduced = userReduced || systemReduced;
  const [interacting, setInteracting] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionRevision = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRevision = useRef(0);
  const wantsPlayback = useRef(false);
  const { clip, idle, interaction, states } = COMPANION_ASSETS[skinId];
  const performing = interacting && !!clip && !reduced && pageVisible && !videoFailed;
  wantsPlayback.current = performing;

  // A new host state or hidden page retires the current interaction.
  useEffect(() => {
    setInteracting(false);
    return () => {
      interactionRevision.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [pageVisible, taskState]);

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
      video.currentTime = 0;
    }
    return () => {
      playbackRevision.current++;
      video.pause();
    };
  }, [performing, pageVisible]);

  function interact() {
    if (timer.current !== null) clearTimeout(timer.current);
    const revision = ++interactionRevision.current;
    setInteracting(true);
    timer.current = setTimeout(() => {
      if (revision !== interactionRevision.current) return;
      timer.current = null;
      setInteracting(false);
    }, INTERACTION_MS);
  }

  const pose = interacting ? interaction : (states?.[taskState] ?? idle);

  return (
    <section
      className={`builtin-skin builtin-skin--${skinId}`}
      aria-label={t('skin.regionLabel')}
      data-builtin-skin={skinId}
      data-companion-view={view}
      data-task-state={taskState}
      data-reduced-motion={reduced}
      data-scene-motion={!pageVisible ? 'paused' : reduced ? 'reduced' : 'full'}
      data-interacting={interacting}
      data-performing={performing}
    >
      <div className="builtin-skin__copy">
        {skinId === 'gugugaga' && (
          <div className="builtin-skin__eyebrow">{t(SKIN_LABEL_KEYS.gugugaga)}</div>
        )}
        <h2>{t(skinId === 'gugugaga' ? 'skin.gugugagaScene' : SKIN_LABEL_KEYS[skinId])}</h2>
        {view === 'workspace' && <span>{t(`skin.state.${taskState}`)}</span>}
        {reduced && <small>{t('skin.reducedMotion')}</small>}
      </div>
      <div className="builtin-skin__stage">
        <span className="builtin-skin__plinth" aria-hidden="true" />
        <div className={`builtin-skin__art builtin-skin__art--${skinId}`} aria-hidden="true">
          <img src={pose} alt="" draggable={false} />
          {clip && (
            <video
              ref={videoRef}
              src={clip}
              poster={interaction}
              className={performing ? 'builtin-skin__video is-playing' : 'builtin-skin__video'}
              muted
              loop
              playsInline
              preload="metadata"
              onError={() => setVideoFailed(true)}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        className="builtin-skin__interact"
        onClick={interact}
        aria-pressed={interacting}
      >
        <span aria-hidden="true">{skinId === 'deepseek' ? '+' : '▷'}</span>
        {t(skinId === 'deepseek' ? 'skin.feed' : skinId === 'naiwa' ? 'skin.poke' : 'skin.cheer')}
      </button>
    </section>
  );
}
