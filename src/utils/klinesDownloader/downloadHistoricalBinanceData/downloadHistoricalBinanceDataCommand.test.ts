import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  downloadBinanceDataFile,
} from './downloadHistoricalBinanceDataCommand';

type RequestGet = (
  url: string,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

type FakeResponse = IncomingMessage & PassThrough & { complete: boolean };

const tempDirs: string[] = [];

function createFakeRequest(): ClientRequest {
  const request = new EventEmitter() as ClientRequest & {
    timeoutHandler?: () => void;
  };

  request.setTimeout = ((_timeout: number, callback?: () => void) => {
    request.timeoutHandler = callback;
    return request;
  }) as ClientRequest['setTimeout'];

  request.destroy = ((error?: Error) => {
    if (error) {
      queueMicrotask(() => {
        request.emit('error', error);
      });
    }
    return request;
  }) as ClientRequest['destroy'];

  return request;
}

function createFakeResponse(headers: Record<string, string> = {}): FakeResponse {
  const response = new PassThrough() as FakeResponse;
  response.headers = headers;
  response.complete = false;
  return response;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('downloadBinanceDataFile', () => {
  it('downloads and verifies a file before marking it successful', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'binance-download-success-'));
    tempDirs.push(outputDir);
    const zipData = Buffer.from('zip-payload');
    const checksum = crypto.createHash('sha256').update(zipData).digest('hex');

    const requestGet: RequestGet = ((url, callback) => {
      const req = createFakeRequest();
      queueMicrotask(() => {
        const response = createFakeResponse(
          url.endsWith('.CHECKSUM') ? { 'content-type': 'text/plain' } : { 'content-type': 'application/zip' }
        );
        callback(response);
        if (url.endsWith('.CHECKSUM')) {
          response.complete = true;
          response.end(`${checksum}  file.zip\n`);
          return;
        }

        response.complete = true;
        response.end(zipData);
      });
      return req;
    }) as RequestGet;

    const result = await downloadBinanceDataFile(
      'https://example.com/SOLUSDT-1m-2026-01-01.zip',
      outputDir,
      requestGet
    );

    expect(result).toEqual({
      status: 'success',
      fileName: 'SOLUSDT-1m-2026-01-01.zip',
    });
    expect(
      await readFile(join(outputDir, 'SOLUSDT-1m-2026-01-01.zip'), 'utf8')
    ).toBe(zipData.toString('utf8'));
  });

  it('fails promptly when the response is aborted mid-download', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'binance-download-abort-'));
    tempDirs.push(outputDir);

    const requestGet: RequestGet = ((url, callback) => {
      const req = createFakeRequest();
      queueMicrotask(() => {
        if (url.endsWith('.CHECKSUM')) {
          req.destroy(new Error('checksum should not be requested after an aborted download'));
          return;
        }

        const response = createFakeResponse({ 'content-type': 'application/zip' });
        callback(response);
        response.write('partial');
        response.emit('aborted');
        response.destroy();
      });
      return req;
    }) as RequestGet;

    const result = await withTimeout(
      downloadBinanceDataFile(
        'https://example.com/SOLUSDT-1m-2026-01-02.zip',
        outputDir,
        requestGet
      )
    );

    expect(result.status).toBe('fail');
    expect(result.fileName).toBe('SOLUSDT-1m-2026-01-02.zip');
    expect(result.error).toContain('download response aborted');
  });
});
