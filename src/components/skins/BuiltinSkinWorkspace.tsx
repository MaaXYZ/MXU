import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Compass, Sprout, Route, Waves } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsMobile } from '@/hooks/useIsMobile';
import { TabBar } from '@/components/TabBar';
import { TaskList } from '@/components/TaskList';
import { Toolbar } from '@/components/Toolbar';
import { AddTaskPanel } from '@/components/AddTaskPanel';
import { ConnectionPanel } from '@/components/ConnectionPanel';
import { ScreenshotPanel } from '@/components/ScreenshotPanel';
import { LogsPanel } from '@/components/LogsPanel';
import { BuiltinSkinCompanion } from './BuiltinSkinCompanion';
import { getSkinTaskState } from './state';
import './workspace-base.css';
import './workspace-ocean.css';
import './workspace-pond.css';

/** Both scenes arrange the same mounted business controls in different physical spaces. */
export function BuiltinSkinWorkspace({
  showAddPanel,
  onToggleAddPanel,
}: {
  showAddPanel: boolean;
  onToggleAddPanel: () => void;
}) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const { skinId, instance, status, instrumentsExpanded } = useAppStore(
    useShallow((state) => ({
      skinId: state.skinId,
      instrumentsExpanded: state.sidePanelExpanded,
      instance: state.instances.find((entry) => entry.id === state.activeInstanceId),
      status: state.activeInstanceId ? state.instanceTaskStatus[state.activeInstanceId] : null,
    })),
  );
  const ocean = skinId === 'deepseek';
  const taskState = getSkinTaskState(!!instance?.isRunning, status);
  const enabled =
    instance?.selectedTasks.filter((task) => task.enabled || task.runOnce).length ?? 0;

  return (
    <div
      className={`scene-workspace scene-workspace--${skinId}`}
      data-skin-slot="workspace"
      data-scene-layout={skinId}
      data-instruments-expanded={mobile || instrumentsExpanded}
    >
      <div className="scene-decoration" data-scene-decoration aria-hidden="true">
        <svg
          className="scene-ocean-art"
          viewBox="0 0 1440 960"
          preserveAspectRatio="xMidYMid slice"
        >
          <path
            className="scene-sea-floor"
            d="M0 690 C180 600 270 780 500 710 S920 600 1440 750 V960 H0Z"
          />
          <path
            className="scene-waterline"
            d="M-100 770 C200 650 400 850 720 740 S1230 680 1540 800 M-100 810 C200 690 400 890 720 780 S1230 720 1540 840"
          />
          <g className="scene-seaweed">
            <path d="M80 960 Q130 800 60 650 Q150 730 120 850 Q200 680 160 590 Q280 750 200 960Z" />
            <path d="M1350 960 Q1280 810 1360 670 Q1260 760 1300 870 Q1210 700 1260 610 Q1130 770 1210 960Z" />
          </g>
          <g className="scene-ocean-life">
            <path d="M820 140 Q930 90 1040 140 Q940 190 820 140 L790 110 V170Z" />
            <path d="M1130 240 Q1200 205 1270 240 Q1200 275 1130 240 L1110 222 V258Z" />
            <path d="M280 610 Q340 580 400 610 Q340 640 280 610 L260 595 V625Z" />
          </g>
          <g className="scene-sonar-rings" fill="none">
            <circle cx="1250" cy="180" r="150" />
            <circle cx="1250" cy="180" r="205" />
            <circle cx="1250" cy="180" r="260" />
          </g>
        </svg>
        <svg className="scene-pond-art" viewBox="0 0 1440 960" preserveAspectRatio="xMidYMid slice">
          <path
            className="scene-pond-bank"
            d="M0 0 H340 Q490 140 340 300 Q230 430 390 550 Q510 700 330 960 H0Z"
          />
          <path
            className="scene-pond-shore"
            d="M340 0 Q490 140 340 300 Q230 430 390 550 Q510 700 330 960"
            fill="none"
          />
          <g className="scene-lily-pads">
            <path d="M980 820 A110 72 0 1 1 985 840 L920 830Z" />
            <path d="M1300 140 A85 56 0 1 1 1305 160 L1250 150Z" />
            <path d="M110 470 A75 48 0 1 1 115 490 L60 480Z" />
            <path d="M690 70 A55 36 0 1 1 695 90 L650 80Z" />
          </g>
          <g className="scene-pond-ripples" fill="none">
            <ellipse cx="1240" cy="760" rx="150" ry="40" />
            <ellipse cx="1240" cy="760" rx="200" ry="57" />
            <ellipse cx="600" cy="420" rx="80" ry="22" />
            <ellipse cx="150" cy="640" rx="115" ry="28" />
          </g>
          <g className="scene-pond-reeds">
            <path d="M1380 960 Q1320 760 1380 660 Q1420 820 1400 960 M1330 960 Q1250 820 1290 730 Q1350 810 1360 960 M40 0 Q130 150 65 210 Q30 120 40 0" />
          </g>
        </svg>
      </div>
      <header className="scene-heading">
        <div className="scene-kicker">
          {ocean ? <Compass aria-hidden="true" /> : <Sprout aria-hidden="true" />}
          <span>{instance?.name}</span>
        </div>
        <h1>{t(ocean ? 'skin.deepseekScene' : 'skin.naiwaScene')}</h1>
        <div className="scene-status" data-task-state={taskState} role="status" aria-live="polite">
          <span aria-hidden="true" />
          {t(`skin.state.${taskState}`)}
        </div>
      </header>
      <nav className="scene-navigation" aria-label={t('skin.instances')}>
        <div className="scene-navigation__crest" aria-hidden="true">
          {ocean ? <Waves /> : <Sprout />}
        </div>
        <TabBar orientation={ocean && !mobile ? 'vertical' : 'horizontal'} />
      </nav>
      <section className="scene-tasks" data-skin-slot="task-panel">
        <div className="scene-task-heading">
          <Route aria-hidden="true" />
          <h2>{t(ocean ? 'skin.route' : 'skin.pondRoute')}</h2>
          <span>{t('skin.taskCount', { count: enabled })}</span>
        </div>
        <TaskList />
        <div
          className="scene-picker grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: showAddPanel ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden min-h-0">
            <AddTaskPanel />
          </div>
        </div>
        <Toolbar showAddPanel={showAddPanel} onToggleAddPanel={onToggleAddPanel} />
      </section>
      <div className="scene-companion">
        <BuiltinSkinCompanion />
      </div>
      <aside
        className="scene-instruments"
        data-skin-slot="sidebar"
        aria-label={t('skin.instruments')}
      >
        <div className="scene-monitor">
          <ScreenshotPanel />
        </div>
        <div className="scene-devices">
          <ConnectionPanel />
        </div>
      </aside>
      <section className="scene-logbook">
        <LogsPanel />
      </section>
    </div>
  );
}
