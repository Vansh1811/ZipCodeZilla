import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'downloader' });

export interface DownloadOptions {
  baseUrl?: string;
  destDir?: string;
  timeoutMs?: number;
  maxRetries?: number;
  force?: boolean;
}

export class GeoNameDownloader {
  private baseUrl: string;
  private destDir: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options?: DownloadOptions) {
    this.baseUrl = options?.baseUrl || config.baseUrl;
    this.destDir = options?.destDir || config.downloadsDir;
    this.timeoutMs = options?.timeoutMs || config.timeoutMs;
    this.maxRetries = options?.maxRetries ?? config.maxRetries;

    if (!fs.existsSync(this.destDir)) {
      fs.mkdirSync(this.destDir, { recursive: true });
    }
  }

  /**
   * Downloads a single file from the GeoNames export endpoint.
   * Uses streaming to temporary file, with exponential backoff retries.
   */
  public async downloadFile(filename: string, options?: { force?: boolean }): Promise<string> {
    const targetUrl = new URL(filename, this.baseUrl).toString();
    const finalPath = path.join(this.destDir, filename);
    const tempPath = `${finalPath}.tmp`;

    if (!options?.force && fs.existsSync(finalPath)) {
      const stats = fs.statSync(finalPath);
      if (stats.size > 0) {
        logger.info({ filename, size: stats.size }, 'File already downloaded, skipping');
        return finalPath;
      }
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        logger.info({ filename, attempt, targetUrl }, 'Starting file download');
        const response = await fetch(targetUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'LocationPipeline/1.0 (production-location-ingestion)'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} for ${targetUrl}`);
        }

        if (!response.body) {
          throw new Error(`Empty response body from ${targetUrl}`);
        }

        // Stream web ReadableStream to file via Node.js Readable with signal
        const nodeReadable = Readable.fromWeb(response.body as any);
        const fileWriteStream = fs.createWriteStream(tempPath);

        await pipeline(nodeReadable, fileWriteStream, { signal: controller.signal });
        clearTimeout(timeoutId);

        // Atomic rename of completed download
        fs.renameSync(tempPath, finalPath);

        const finalStats = fs.statSync(finalPath);
        logger.info(
          { filename, size: finalStats.size, attempt },
          'Successfully downloaded file'
        );
        return finalPath;
      } catch (err: any) {
        clearTimeout(timeoutId);

        // Clean up incomplete temp file if exists
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // Ignore cleanup error
          }
        }

        const isAbort = err.name === 'AbortError';
        const isLastAttempt = attempt > this.maxRetries;

        logger.warn(
          {
            filename,
            attempt,
            maxRetries: this.maxRetries,
            error: err.message,
            isAbort
          },
          'Download attempt failed'
        );

        if (isLastAttempt) {
          throw new Error(
            `Failed to download ${filename} after ${attempt} attempts: ${err.message}`
          );
        }

        // Exponential backoff with jitter (e.g. 1s, 2s, 4s + random 0-500ms)
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error(`Exceeded max retries for ${filename}`);
  }

  /**
   * Extracts a specific txt file from a downloaded zip file.
   */
  public async extractZip(
    zipPath: string,
    targetTxtFileName?: string
  ): Promise<string> {
    const dir = path.dirname(zipPath);
    const baseName = path.basename(zipPath, '.zip');
    const expectedTxt = targetTxtFileName || `${baseName}.txt`;
    const finalTxtPath = path.join(dir, expectedTxt);

    if (fs.existsSync(finalTxtPath)) {
      const stats = fs.statSync(finalTxtPath);
      if (stats.size > 0) {
        logger.info({ extractedFile: finalTxtPath }, 'Extracted file already exists, skipping unzipping');
        return finalTxtPath;
      }
    }

    logger.info({ zipPath, expectedTxt }, 'Extracting zip archive');
    const directory = await unzipper.Open.file(zipPath);
    const entry = directory.files.find(
      (file) => file.path === expectedTxt || file.path.endsWith(`/${expectedTxt}`)
    );

    if (!entry) {
      // Fallback: look for any .txt file that isn't readme.txt
      const fallbackEntry = directory.files.find(
        (file) => file.path.endsWith('.txt') && !file.path.toLowerCase().includes('readme')
      );
      if (!fallbackEntry) {
        throw new Error(`Could not find ${expectedTxt} in zip archive ${zipPath}`);
      }
      return this.writeZipEntry(fallbackEntry, finalTxtPath);
    }

    return this.writeZipEntry(entry, finalTxtPath);
  }

  private async writeZipEntry(entry: any, destPath: string): Promise<string> {
    const tempPath = `${destPath}.tmp`;
    const writeStream = fs.createWriteStream(tempPath);

    await pipeline(entry.stream(), writeStream);
    fs.renameSync(tempPath, destPath);

    logger.info({ destPath }, 'Successfully extracted file');
    return destPath;
  }

  /**
   * Downloads and extracts the dataset for a given country ISO code.
   */
  public async downloadAndExtractCountry(countryCode: string): Promise<string> {
    const code = countryCode.toUpperCase();
    const zipFilename = `${code}.zip`;
    const zipPath = await this.downloadFile(zipFilename);
    const txtPath = await this.extractZip(zipPath, `${code}.txt`);
    return txtPath;
  }

  /**
   * Downloads and extracts the worldwide populated places dataset (e.g. cities500.zip).
   */
  public async downloadAndExtractGlobalCities(datasetFilename: string = 'cities500.zip'): Promise<string> {
    const baseName = path.basename(datasetFilename, '.zip');
    const zipPath = await this.downloadFile(datasetFilename);
    const txtPath = await this.extractZip(zipPath, `${baseName}.txt`);
    return txtPath;
  }

  /**
   * Downloads reference files needed for enrichment: countryInfo.txt & admin1CodesASCII.txt.
   */
  public async downloadReferenceFiles(): Promise<{ countryInfoPath: string; admin1CodesPath: string }> {
    const countryInfoPath = await this.downloadFile('countryInfo.txt');
    const admin1CodesPath = await this.downloadFile('admin1CodesASCII.txt');

    return {
      countryInfoPath,
      admin1CodesPath
    };
  }
}

export const defaultDownloader = new GeoNameDownloader();
export default defaultDownloader;
