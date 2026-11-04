import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskRunTiming } from '@/types/maa';
import { formatTaskDuration } from '@/utils/taskTiming';
import { Tooltip } from './ui/Tooltip';

/** Details of the latest execution; no live timer or configuration fields are needed. */
export function TaskTimingBadge({ timing }: { timing: TaskRunTiming | undefined }) {
  const { t, i18n } = useTranslation();
  if (!timing) return null;

  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString(i18n.language);
  const startedAt = t('taskItem.timing.startedAt', { time: formatTime(timing.startedAt) });
  const finishedAt =
    timing.finishedAt !== null
      ? t('taskItem.timing.finishedAt', { time: formatTime(timing.finishedAt) })
      : undefined;
  const duration = timing.durationMs !== null ? formatTaskDuration(timing.durationMs) : undefined;
  const elapsed = duration ? t('taskItem.timing.duration', { time: duration }) : undefined;

  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <div>{startedAt}</div>
          {finishedAt && <div>{finishedAt}</div>}
          {elapsed && <div>{elapsed}</div>}
        </div>
      }
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={[startedAt, finishedAt, elapsed].filter(Boolean).join('; ')}
        className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-text-secondary tabular-nums rounded focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Clock className="w-3 h-3" aria-hidden="true" />
        {duration}
      </span>
    </Tooltip>
  );
}
