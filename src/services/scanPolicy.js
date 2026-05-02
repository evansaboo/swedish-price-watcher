export function shouldSkipDiscordNotifications({ sourceState = {}, scanState = {} } = {}) {
  return !sourceState.lastSuccessAt || Boolean(scanState.cancelling) || Boolean(scanState.abortController?.signal?.aborted);
}
