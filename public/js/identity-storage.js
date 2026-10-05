(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.FacilitatIdentityStorage = api.install(root);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const PREFIX = 'facilitatio:identity:v2:',
    MARKER = 'facilitatio:active-identity:v2';
  function create(nativeLocal, nativeSession) {
    let identity = null,
      generation = 0;
    const listeners = new Set();
    function activate(id, broadcast = true) {
      const next =
        typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
      if (next === identity) return;
      identity = next;
      generation++;
      if (broadcast) nativeLocal.setItem(MARKER, next || '');
      for (const fn of listeners) fn({ identity, generation });
    }
    function scope(storage) {
      return {
        getItem(key) {
          return identity
            ? storage.getItem(PREFIX + identity + ':' + key)
            : null;
        },
        setItem(key, value) {
          if (identity)
            storage.setItem(PREFIX + identity + ':' + key, String(value));
        },
        removeItem(key) {
          if (identity) storage.removeItem(PREFIX + identity + ':' + key);
        },
        key(index) {
          const keys = [];
          if (identity)
            for (let i = 0; i < storage.length; i++) {
              const k = storage.key(i);
              if (k.startsWith(PREFIX + identity + ':'))
                keys.push(k.slice((PREFIX + identity + ':').length));
            }
          return keys[index] || null;
        },
        get length() {
          let count = 0;
          while (this.key(count) !== null) count++;
          return count;
        },
        clear() {
          const keys = [];
          for (let i = 0; i < this.length; i++) keys.push(this.key(i));
          for (const key of keys) this.removeItem(key);
        }
      };
    }
    return {
      local: scope(nativeLocal),
      session: scope(nativeSession),
      activate,
      capture: () => ({ identity, generation }),
      current: (stamp) =>
        stamp.identity === identity && stamp.generation === generation,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      storageEvent(event) {
        if (event.key === MARKER && event.newValue !== (identity || '')) {
          activate(null, false);
          return true;
        }
        return false;
      },
      isStorageEvent: (event) => event.storageArea === nativeLocal,
      logicalKey(event) {
        const prefix = PREFIX + identity + ':';
        return identity && event.key?.startsWith(prefix)
          ? event.key.slice(prefix.length)
          : null;
      },
      get identity() {
        return identity;
      },
      get generation() {
        return generation;
      }
    };
  }
  function install(win) {
    const nativeLocal = win.localStorage,
      nativeSession = win.sessionStorage,
      api = create(nativeLocal, nativeSession);
    const nativeFetch = win.fetch?.bind(win);
    let probe = 0;
    const isUserApi = (path) =>
      path === '/chat' ||
      path.startsWith('/chat/') ||
      path.startsWith('/session/') ||
      (path.startsWith('/api/') &&
        !path.startsWith('/api/auth/') &&
        !path.startsWith('/api/admin/') &&
        !path.startsWith('/api/pros/') &&
        !path.startsWith('/api/facilitation/') &&
        !path.startsWith('/api/twa/') &&
        path !== '/api/emergency-support');
    function invalidate() {
      api.activate(null);
      win.dispatchEvent(new win.CustomEvent('facilitat-identity-invalidated'));
    }
    if (nativeFetch)
      win.fetch = async function (input, options = {}) {
        const url = new URL(
            typeof input === 'string' ? input : input.url,
            win.location.origin
          ),
          stamp = api.capture();
        const authProbe = url.pathname === '/api/auth/session',
          authLogin = [
            '/api/auth/login',
            '/api/auth/register',
            '/api/account/reset'
          ].includes(url.pathname);
        const currentProbe = authProbe ? ++probe : probe;
        if (url.pathname === '/api/auth/logout') invalidate();
        if (
          url.origin === win.location.origin &&
          isUserApi(url.pathname) &&
          !api.identity
        )
          throw new win.DOMException(
            'Authenticated identity unavailable',
            'AbortError'
          );
        const headers = new win.Headers(
          options.headers || input?.headers || {}
        );
        if (url.origin === win.location.origin && isUserApi(url.pathname))
          headers.set('x-client-identity', api.identity);
        const response = await nativeFetch(input, { ...options, headers });
        if (authProbe || authLogin) {
          const data = await response
            .clone()
            .json()
            .catch(() => null);
          if (authProbe && currentProbe !== probe)
            throw new win.DOMException(
              'Superseded identity probe',
              'AbortError'
            );
          if (authLogin && !api.current(stamp))
            throw new win.DOMException('Identity changed', 'AbortError');
          api.activate(
            response.ok && data?.authenticated !== false ? data?.user?.id : null
          );
        } else if (isUserApi(url.pathname) && !api.current(stamp))
          throw new win.DOMException('Identity changed', 'AbortError');
        return response;
      };
    win.addEventListener('storage', (event) => {
      if (api.storageEvent(event)) {
        win.dispatchEvent(
          new win.CustomEvent('facilitat-identity-invalidated')
        );
        win.location.reload();
      }
    });
    api.subscribe(() =>
      win.dispatchEvent(new win.CustomEvent('facilitat-identity-invalidated'))
    );
    if (win.navigator?.sendBeacon) {
      win.navigator.sendBeacon = (url, data) => {
        if (!api.identity) return false;
        win
          .fetch(url, {
            method: 'POST',
            body: data,
            keepalive: true,
            credentials: 'include'
          })
          .catch(() => {});
        return true;
      };
    }
    api.ready = nativeFetch
      ? win
          .fetch('/api/auth/session', {
            credentials: 'include',
            cache: 'no-store'
          })
          .catch(() => {
            api.activate(null);
          })
      : Promise.resolve();
    return api;
  }
  return { create, install, PREFIX, MARKER };
});
