import { isSourceEnabled } from '../lib/utils.js';

export function shouldSkipDiscordNotifications({ sourceState = {}, scanState = {} } = {}) {
  return !sourceState.lastSuccessAt || Boolean(scanState.cancelling) || Boolean(scanState.abortController?.signal?.aborted);
}

export function shouldSkipSourceNotifications({ source, state, sourceState = {}, scanState = {} } = {}) {
  return !isSourceEnabled(source, state) || shouldSkipDiscordNotifications({ sourceState, scanState });
}
