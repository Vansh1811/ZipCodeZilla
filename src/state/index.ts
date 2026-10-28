import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LockInfo, RunMode, RunState, RunStatus } from '../types.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'state' });

export class StateManager {
  private dataDir: string;
  private stateFilePath: string;
  private lockFilePath: string;
  private currentLock: LockInfo | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.stateFilePath = path.join(this.dataDir, '.run-state.json');
    this.lockFilePath = path.join(this.dataDir, '.lock');
  }

  /**
   * Acquires an exclusive run lock to prevent overlapping pipeline executions.
   */
  public acquireLock(runId: string): boolean {
    if (fs.existsSync(this.lockFilePath)) {
      try {
        const raw = fs.readFileSync(this.lockFilePath, 'utf8');
        const lockInfo: LockInfo = JSON.parse(raw);

        // Check if process is still alive
        if (this.isProcessAlive(lockInfo.pid)) {
          // Check if lock has been held for more than 24 hours (stale safety threshold)
          const lockAgeMs = Date.now() - new Date(lockInfo.startedAt).getTime();
          const maxLockAgeMs = 24 * 60 * 60 * 1000;

          if (lockAgeMs < maxLockAgeMs) {
            logger.error(
              { pid: lockInfo.pid, startedAt: lockInfo.startedAt, runId: lockInfo.runId },
              'Another pipeline run is currently active'
            );
            return false;
          }
          logger.warn(
            { lockInfo, ageHours: lockAgeMs / (3600 * 1000) },
            'Active process lock is older than 24 hours, reclaiming lock'
          );
        } else {
          logger.warn(
            { pid: lockInfo.pid, runId: lockInfo.runId },
            'Found stale lock file from deceased process, reclaiming lock'
          );
        }
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Failed to parse existing lock file, will overwrite');
      }
    }

    const newLock: LockInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runId
    };

    const tempLock = `${this.lockFilePath}.tmp`;
    fs.writeFileSync(tempLock, JSON.stringify(newLock, null, 2), 'utf8');
    fs.renameSync(tempLock, this.lockFilePath);
    this.currentLock = newLock;

    logger.info({ pid: newLock.pid, runId }, 'Pipeline run lock acquired');
    return true;
  }

  /**
   * Releases the active lock.
   */
  public releaseLock(): void {
    if (fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
        logger.info('Pipeline run lock released');
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Error releasing lock file');
      }
    }
    this.currentLock = null;
  }

  /**
   * Checks whether a system process with the given PID is running.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === 'EPERM'; // Exists but belongs to another user
    }
  }

  /**
   * Loads the current run state, or initializes a default if none exists.
   */
  public loadState(): RunState | null {
    if (!fs.existsSync(this.stateFilePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      return JSON.parse(raw) as RunState;
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to read run state file');
      return null;
    }
  }

  /**
   * Initializes a new RunState for an execution.
   */
  public initState(
    mode: RunMode,
    allCountries: string[],
    existingState?: RunState | null
  ): RunState {
    const runId = crypto.randomUUID();
    const lastSuccessfulRun = existingState?.lastSuccessfulRun || null;

    const state: RunState = {
      runId,
      mode,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'running',
      currentCountry: null,
      processedRecords: 0,
      insertedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      apiRequestsCount: 0,
      countriesCompleted: [],
      countriesRemaining: [...allCountries],
      lastError: null,
      lastSuccessfulRun,
      checkpoints: {}
    };

    this.saveState(state);
    return state;
  }

  /**
   * Durably saves state to disk using atomic file rename.
   */
  public saveState(state: RunState): void {
    const tempPath = `${this.stateFilePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, this.stateFilePath);
  }

  /**
   * Records a country-level checkpoint in the state.
   */
  public updateCountryCheckpoint(
    state: RunState,
    countryCode: string,
    lastProcessedLine: number,
    recordCount: number
  ): void {
    state.checkpoints[countryCode] = {
      lastProcessedLine,
      recordCount,
      timestamp: new Date().toISOString()
    };
    this.saveState(state);
  }

  /**
   * Marks a country as completed.
   */
  public markCountryCompleted(
    state: RunState,
    countryCode: string,
    countryRecordCount: number
  ): void {
    const code = countryCode.toUpperCase();
    if (!state.countriesCompleted.includes(code)) {
      state.countriesCompleted.push(code);
    }
    state.countriesRemaining = state.countriesRemaining.filter((c) => c !== code);
    state.insertedRecords += countryRecordCount;
    this.saveState(state);
  }

  /**
   * Marks the entire run as finished with final status.
   */
  public finishRun(state: RunState, status: RunStatus, error?: string): void {
    state.status = status;
    state.completedAt = new Date().toISOString();
    if (error) {
      state.lastError = error;
    }
    if (status === 'completed') {
      state.lastSuccessfulRun = state.completedAt;
    }
    this.saveState(state);
  }
}
