import { Temporal } from '@js-temporal/polyfill';
import type { DigestJobStore } from '../domain/jobs.js';

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type ScheduleBase = { id: string; enabled: boolean; time: `${number}${number}:${number}${number}`; timezone?: string };
export type ScheduleDefinition =
  | (ScheduleBase & { mode: 'preset'; preset: 'daily' | 'weekdays' | 'weekly'; dayOfWeek?: Weekday })
  | (ScheduleBase & { mode: 'custom'; weekdays: Weekday[] });

export type Clock = { now(): string };
export interface ScheduleState {
  firstRunEnqueuedAt(): Promise<string | null>;
  lastScheduledAt(scheduleId: string): Promise<string | null>;
  markFirstRunEnqueued(at: string): Promise<void>;
  markScheduled(scheduleId: string, at: string): Promise<void>;
}

type SchedulerJobs = Pick<DigestJobStore, 'enqueue'>;
export type ScheduledSlot = { scheduleId: string; at: string; triggerWindowId: string; kind: 'daily' | 'weekly' };
export type SchedulerResult = { queued: string[]; failures: Array<{ scheduleId: string; reason: 'STORAGE_FAILED' }> };

export class Scheduler {
  private readonly timezone: string;

  constructor(private readonly dependencies: {
    schedules: ScheduleDefinition[];
    jobs: SchedulerJobs;
    state: ScheduleState;
    clock: Clock;
    defaultTimezone?: string;
  }) {
    if (dependencies.schedules.length === 0) throw new Error('SCHEDULE_REQUIRED');
    this.timezone = dependencies.defaultTimezone ?? 'UTC';
    for (const schedule of dependencies.schedules) validateSchedule(schedule, this.timezone);
  }

  async runImmediateFirst(): Promise<SchedulerResult> {
    if (await this.dependencies.state.firstRunEnqueuedAt()) return emptyResult();
    const now = this.dependencies.clock.now();
    try {
      const result = await this.dependencies.jobs.enqueue({ triggerWindowId: 'v2:initial', kind: 'manual' });
      await this.dependencies.state.markFirstRunEnqueued(now);
      return result.status === 'queued' ? { queued: ['v2:initial'], failures: [] } : emptyResult();
    } catch {
      return { queued: [], failures: [{ scheduleId: '__initial__', reason: 'STORAGE_FAILED' }] };
    }
  }

  async runDue(): Promise<SchedulerResult> {
    const now = this.dependencies.clock.now();
    const result = emptyResult();
    for (const schedule of this.dependencies.schedules.filter((item) => item.enabled)) {
      const lastScheduledAt = await this.dependencies.state.lastScheduledAt(schedule.id);
      for (const slot of dueSlots(schedule, lastScheduledAt, now, this.timezone)) {
        try {
          const queued = await this.dependencies.jobs.enqueue({ triggerWindowId: slot.triggerWindowId, kind: slot.kind });
          await this.dependencies.state.markScheduled(schedule.id, slot.at);
          if (queued.status === 'queued') result.queued.push(slot.triggerWindowId);
        } catch {
          result.failures.push({ scheduleId: schedule.id, reason: 'STORAGE_FAILED' });
          break;
        }
      }
    }
    return result;
  }
}

export function dueSlots(schedule: ScheduleDefinition, lastScheduledAt: string | null, now: string, defaultTimezone = 'UTC'): ScheduledSlot[] {
  const timezone = schedule.timezone ?? defaultTimezone;
  const nowInstant = Temporal.Instant.from(now);
  const nowDate = nowInstant.toZonedDateTimeISO(timezone).toPlainDate();
  let date = lastScheduledAt
    ? Temporal.Instant.from(lastScheduledAt).toZonedDateTimeISO(timezone).toPlainDate()
    : nowDate;
  const earliest = lastScheduledAt ? Temporal.Instant.from(lastScheduledAt) : null;
  const slots: ScheduledSlot[] = [];
  while (Temporal.PlainDate.compare(date, nowDate) <= 0) {
    if (runsOn(schedule, date.dayOfWeek as Weekday)) {
      const at = date.toZonedDateTime({ timeZone: timezone, plainTime: schedule.time }).toInstant();
      if ((!earliest || Temporal.Instant.compare(at, earliest) > 0) && Temporal.Instant.compare(at, nowInstant) <= 0) {
        const kind = schedule.mode === 'preset' && schedule.preset === 'daily' ? 'daily' : 'weekly';
        slots.push({ scheduleId: schedule.id, at: at.toString(), triggerWindowId: `v2:${schedule.id}:${at.epochMilliseconds}`, kind });
      }
    }
    date = date.add({ days: 1 });
  }
  return slots;
}

function runsOn(schedule: ScheduleDefinition, day: Weekday): boolean {
  if (schedule.mode === 'custom') return schedule.weekdays.includes(day);
  if (schedule.preset === 'daily') return true;
  if (schedule.preset === 'weekdays') return day <= 5;
  return day === schedule.dayOfWeek;
}

function validateSchedule(schedule: ScheduleDefinition, defaultTimezone: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('INVALID_SCHEDULE_TIME');
  if (schedule.mode === 'custom' && schedule.weekdays.length === 0) throw new Error('SCHEDULE_REQUIRED');
  if (schedule.mode === 'preset' && schedule.preset === 'weekly' && !schedule.dayOfWeek) throw new Error('WEEKLY_DAY_REQUIRED');
  Temporal.Now.zonedDateTimeISO(schedule.timezone ?? defaultTimezone);
}

function emptyResult(): SchedulerResult { return { queued: [], failures: [] }; }
