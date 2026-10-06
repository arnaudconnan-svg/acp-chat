(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FacilitatLocalDestination = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const PATHS = new Set([
    '/',
    '/index.html',
    '/auth.html',
    '/account.html',
    '/pros.html',
    '/admin.html',
    '/support-admin.html',
    '/facilitation-admin.html',
    '/pros-login.html',
    '/twa-login.html',
    '/launch-bridge.html'
  ]);
  const PARAMS = new Set([
    'screen',
    'launch',
    'launchAuthDone',
    'fromProsLogin',
    '_android_country',
    '_suppress_web_relock_until',
    'source',
    'view'
  ]);
  function resolve(raw, fallback = '/') {
    if (
      typeof raw !== 'string' ||
      !raw.startsWith('/') ||
      raw.startsWith('//') ||
      /[\\%\s\u0000-\u001f\u007f]/.test(raw) ||
      raw.includes('//') ||
      raw.includes('#')
    )
      return fallback;
    try {
      const u = new URL(raw, 'https://local.invalid');
      if (
        u.origin !== 'https://local.invalid' ||
        u.pathname !== raw.split('?')[0] ||
        !PATHS.has(u.pathname)
      )
        return fallback;
      for (const [key, value] of u.searchParams)
        if (!PARAMS.has(key) || !/^[A-Za-z0-9_-]{0,80}$/.test(value))
          return fallback;
      return u.pathname + u.search;
    } catch {
      return fallback;
    }
  }
  return { resolve };
});
