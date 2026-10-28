import cron from 'node-cron';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { LocationCacheService, defaultCacheService } from '../cache/index.js';
import { StateManager } from '../state/index.js';

const logger = createLogger({ module: 'scheduler' });

export class LocationScheduler {
  private cacheService: LocationCacheService;
  private stateManager: StateManager;
  private cronExpression: string;
  private task: cron.ScheduledTask | null = null;
  private isExecuting = false;

  constructor(options?: {
    cacheService?: LocationCacheService;
    stateManager?: StateManager;
    cronExpression?: string;
  }) {
    this.cacheService = options?.cacheService || defaultCacheService;
    this.stateManager = options?.stateManager || new StateManager(config.dataDir);
    this.cronExpression = options?.cronExpression || config.cronSchedule;
  }

  /**
   * Starts the background cron scheduler.
   */
  public start(): boolean {
    if (!cron.validate(this.cronExpression)) {
      logger.error({ cronExpression: this.cronExpression }, 'Invalid cron schedule expression provided');
      return false;
    }

    logger.info(
      { cronSchedule: this.cronExpression, timezone: 'UTC', ttlDays: config.cacheTtlDays },
      'Initializing Location Ingestion & Refresh Cron Scheduler'
    );

    this.task = cron.schedule(
      this.cronExpression,
      async () => {
        if (this.isExecuting) {
          logger.warn('Previous scheduled refresh job is still active, skipping trigger');
          return;
        }

        const runId = `cron-${Date.now()}`;
        if (!this.stateManager.acquireLock(runId)) {
          logger.warn('Could not acquire scheduler lock, skipping run');
          return;
        }

        this.isExecuting = true;
        const triggerTime = new Date().toISOString();
        logger.info({ triggerTime, runId }, 'Executing scheduled cache maintenance (pruning expired records)');

        try {
          // Permitted maintenance: prune records exceeding 30-day TTL (0 external API calls)
          const stats = await this.cacheService.pruneExpiredRecords();
          logger.info({ triggerTime, runId, stats }, 'Scheduled cache maintenance completed (0 external API calls)');
        } catch (err: any) {
          logger.error({ triggerTime, runId, error: err.message }, 'Scheduled cache maintenance encountered error');
        } finally {
          this.stateManager.releaseLock();
          this.isExecuting = false;
        }
      },
      {
        timezone: 'UTC'
      }
    );

    logger.info('Scheduler started successfully. Waiting for next cron trigger.');
    return true;
  }

  /**
   * Stops the active cron schedule.
   */
  public stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Scheduler stopped');
    }
  }

  public isRunning(): boolean {
    return this.task !== null;
  }
}

export const defaultScheduler = new LocationScheduler();
export default defaultScheduler;
