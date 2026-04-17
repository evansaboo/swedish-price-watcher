import robotsParser from 'robots-parser';

import { sleep } from './utils.js';

export class FetchBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FetchBlockedError';
    this.disableHours = details.disableHours ?? 0;
    this.statusCode = details.statusCode ?? null;
  }
}

export class PoliteFetcher {
  constructor(options) {
    this.userAgent = options.userAgent;
    this.hostDelayMs = options.hostDelayMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.disableHoursOnBlock = options.disableHoursOnBlock;
    this.hostState = new Map();
    this.robotsCache = new Map();
  }

  async fetchText(source, sourceState, url, options = {}) {
    const result = await this.#request(source, sourceState, url, options);
    return result.notModified ? result : { ...result, body: await result.response.text() };
  }

  async fetchJsonApi(urlString, options = {}) {
    const url = new URL(urlString);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported protocol for API request: ${url.protocol}`);
    }

    if (!options.skipHostDelay) {
      await this.#waitForHost(url.host);
    }

    const response = await this.#timedFetch(urlString, {
      method: options.method ?? 'GET',
      headers: {
        'user-agent': this.userAgent,
        accept: options.accept ?? 'application/json',
        ...options.headers
      },
      body: options.body,
      timeoutMs: options.timeoutMs
    });

    if (!options.skipHostDelay) {
      this.#recordHostRequest(url.host);
    }

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message ?? `${response.status} ${response.statusText}`;
      throw new Error(`Request failed for ${urlString}: ${message}`);
    }

    return payload;
  }

  async #request(source, sourceState, urlString, options = {}) {
    const url = new URL(urlString);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported protocol for ${source.id}: ${url.protocol}`);
    }

    await this.#ensureRobotsAllowed(url);
    await this.#waitForHost(url.host);

    const headers = {
      'user-agent': this.userAgent,
      accept: options.accept ?? '*/*',
      ...options.headers
    };

    if (sourceState?.etag) {
      headers['if-none-match'] = sourceState.etag;
    }

    if (sourceState?.lastModified) {
      headers['if-modified-since'] = sourceState.lastModified;
    }

    const response = await this.#timedFetch(urlString, {
      method: options.method ?? 'GET',
      headers,
      body: options.body
    });

    this.#recordHostRequest(url.host);

    if (response.status === 304) {
      return { response, notModified: true };
    }

    if (sourceState) {
      sourceState.etag = response.headers.get('etag') ?? sourceState.etag ?? null;
      sourceState.lastModified = response.headers.get('last-modified') ?? sourceState.lastModified ?? null;
    }

    if (response.status === 403 || response.status === 429) {
      throw new FetchBlockedError(
        `${source.label ?? source.id} returned ${response.status}; this source should cool down instead of retrying more aggressively.`,
        { disableHours: this.disableHoursOnBlock, statusCode: response.status }
      );
    }

    if (!response.ok) {
      throw new Error(`${source.label ?? source.id} returned ${response.status} ${response.statusText}`);
    }

    return { response, notModified: false };
  }

  async #ensureRobotsAllowed(url) {
    const parser = await this.#getRobotsParser(url);

    if (!parser) {
      return;
    }

    const allowed = parser.isAllowed(url.toString(), this.userAgent);

    if (allowed === false) {
      throw new FetchBlockedError(`robots.txt disallows ${url.pathname} for ${this.userAgent}.`, {
        disableHours: this.disableHoursOnBlock
      });
    }
  }

  async #getRobotsParser(url) {
    const siteKey = `${url.protocol}//${url.host}`;

    if (this.robotsCache.has(siteKey)) {
      return this.robotsCache.get(siteKey);
    }

    const robotsUrl = `${siteKey}/robots.txt`;

    try {
      await this.#waitForHost(url.host);

      const response = await this.#timedFetch(robotsUrl, {
        method: 'GET',
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/plain,*/*;q=0.8'
        }
      });

      this.#recordHostRequest(url.host);

      if (response.status === 404) {
        this.robotsCache.set(siteKey, null);
        return null;
      }

      if (response.status === 403) {
        const denyAll = robotsParser(robotsUrl, 'User-agent: *\nDisallow: /');
        this.robotsCache.set(siteKey, denyAll);
        return denyAll;
      }

      if (!response.ok) {
        this.robotsCache.set(siteKey, null);
        return null;
      }

      const parser = robotsParser(robotsUrl, await response.text());
      this.robotsCache.set(siteKey, parser);
      return parser;
    } catch {
      this.robotsCache.set(siteKey, null);
      return null;
    }
  }

  async #timedFetch(url, init = {}) {
    const {
      timeoutMs = this.requestTimeoutMs,
      ...fetchInit
    } = init;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...fetchInit,
        signal: controller.signal
      });
    } catch (error) {
      const detail = error?.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : error.message;

      throw new Error(`Request failed for ${url}: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #waitForHost(host) {
    const state = this.hostState.get(host) ?? { nextAllowedAt: 0 };
    const waitMs = state.nextAllowedAt - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  #recordHostRequest(host) {
    const jitter = Math.round(this.hostDelayMs * 0.15 * Math.random());
    this.hostState.set(host, { nextAllowedAt: Date.now() + this.hostDelayMs + jitter });
  }
}
