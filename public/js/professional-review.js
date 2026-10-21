(function (root) {
  'use strict';
  if (!root?.document) return;
  const KEY = 'facilitatio:admin-review:v1';
  const TTL = 10 * 60 * 1000;
  const nativeFetch = root.fetch.bind(root);
  const choices = {
    support_incident: 'Incident de support',
    security_review: 'Revue de sécurité',
    user_request: 'Demande utilisateur',
    identity_verification: 'Vérification d’identité'
  };
  let reason = '',
    unmask = '',
    context = '',
    expiresAt = 0,
    generation = 0;
  let panel, accessSelect, identitySelect, status, waiter, timer;
  const pending = new Set();
  const abortError = () =>
    new root.DOMException('Contexte administrateur renouvelé', 'AbortError');
  function store() {
    try {
      if (reason && context)
        root.sessionStorage.setItem(
          KEY,
          JSON.stringify({ reason, context, expiresAt })
        );
      else root.sessionStorage.removeItem(KEY);
    } catch {
      /* Reason remains usable only in this document if storage is unavailable. */
    }
  }
  function invalidate() {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
    root.dispatchEvent(new root.CustomEvent('facilitat-admin-clear'));
  }
  function sync() {
    if (accessSelect) accessSelect.value = reason;
    if (identitySelect) identitySelect.value = unmask;
  }
  function reset() {
    reason = '';
    unmask = '';
    context = '';
    expiresAt = 0;
    root.clearTimeout(timer);
    store();
    sync();
    if (status) status.textContent = 'Motif à confirmer. Identités masquées.';
    invalidate();
    if (waiter) {
      waiter.reject(abortError());
      waiter = null;
    }
  }
  function arm() {
    root.clearTimeout(timer);
    if (reason)
      timer = root.setTimeout(reset, Math.max(0, expiresAt - Date.now()));
  }
  function refresh() {
    root.dispatchEvent(new root.CustomEvent('facilitat-admin-refresh'));
  }
  function mount() {
    if (panel) return;
    panel = root.document.createElement('aside');
    panel.id = 'adminReviewPanel';
    panel.style.cssText =
      'padding:12px;background:#fff;color:#111;position:sticky;top:0;z-index:1000;display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:14px';
    function select(label, empty) {
      const wrap = root.document.createElement('label');
      wrap.append(label + ' ');
      const input = root.document.createElement('select');
      input.setAttribute('aria-label', label);
      input.style.maxWidth = '100%';
      input.add(new root.Option(empty, ''));
      for (const [code, text] of Object.entries(choices))
        input.add(new root.Option(text, code));
      wrap.append(input);
      panel.append(wrap);
      return input;
    }
    accessSelect = select('Motif administrateur', 'Choisir un motif');
    identitySelect = select(
      'Motif de levée de pseudonymisation',
      'Conserver la pseudonymisation'
    );
    status = root.document.createElement('span');
    status.setAttribute('role', 'status');
    status.textContent = 'Accès journalisé. Identités masquées par défaut.';
    panel.append(status);
    const clear = root.document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Réinitialiser le motif';
    clear.onclick = () => {
      reset();
      refresh();
    };
    panel.append(clear);
    accessSelect.onchange = () => {
      const next = Object.hasOwn(choices, accessSelect.value)
        ? accessSelect.value
        : '';
      const waiting = waiter;
      reason = next;
      unmask = '';
      expiresAt = reason ? Date.now() + TTL : 0;
      if (!waiting) invalidate();
      store();
      sync();
      status.textContent = 'Motif courant mis à jour. Identités masquées.';
      arm();
      if (waiting && reason) {
        waiter = null;
        waiting.resolve();
      } else if (!waiting) refresh();
    };
    identitySelect.onchange = () => {
      unmask =
        reason && context && Object.hasOwn(choices, identitySelect.value)
          ? identitySelect.value
          : '';
      invalidate();
      sync();
      status.textContent = unmask
        ? 'Vérification de l’accès aux identités…'
        : 'Identités remasquées.';
      refresh();
    };
    root.document.body.prepend(panel);
    sync();
  }
  async function requestReason() {
    mount();
    if (!context) throw abortError();
    if (reason && expiresAt <= Date.now()) {
      reset();
      throw abortError();
    }
    if (reason) return;
    if (!waiter) {
      const promise = new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
      waiter.promise = promise;
    }
    await waiter.promise;
  }
  async function session(response, stamp) {
    let data;
    try {
      data = await response.clone().json();
    } catch {
      reset();
      return;
    }
    if (stamp !== generation) throw abortError();
    if (!response.ok || data?.authenticated !== true || !data.reviewContext) {
      reset();
      return;
    }
    const next = String(data.reviewContext);
    if (context && context !== next) reset();
    context = next;
    if (!reason) {
      try {
        const saved = JSON.parse(root.sessionStorage.getItem(KEY));
        if (
          saved?.context === context &&
          Object.hasOwn(choices, saved.reason) &&
          saved.expiresAt > Date.now() &&
          saved.expiresAt <= Date.now() + TTL
        ) {
          reason = saved.reason;
          expiresAt = saved.expiresAt;
        } else root.sessionStorage.removeItem(KEY);
      } catch {
        try {
          root.sessionStorage.removeItem(KEY);
        } catch {
          /* Storage unavailable. */
        }
      }
    }
    store();
    sync();
    arm();
  }
  root.fetch = async function (input, options = {}) {
    const url = new URL(
      typeof input === 'string' ? input : input.url,
      root.location.origin
    );
    if (url.origin !== root.location.origin) return nativeFetch(input, options);
    const authChange = [
      '/api/admin/logout',
      '/api/admin/login',
      '/api/pros/login',
      '/api/pros/logout'
    ].includes(url.pathname);
    if (authChange) reset();
    const protectedApi =
      url.pathname.startsWith('/api/admin/') &&
      !['/api/admin/session', '/api/admin/login', '/api/admin/logout'].includes(
        url.pathname
      );
    if (!protectedApi) {
      const sessionStamp = generation;
      try {
        const response = await nativeFetch(input, options);
        if (url.pathname === '/api/admin/session')
          await session(response, sessionStamp);
        return response;
      } catch (error) {
        if (
          url.pathname === '/api/admin/session' &&
          sessionStamp === generation
        )
          reset();
        throw error;
      }
    }
    await requestReason();
    const stamp = generation;
    const controller = new root.AbortController();
    const signal = options.signal || input?.signal;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    pending.add(controller);
    const timeout = root.setTimeout(() => controller.abort(), 12000);
    const headers = new root.Headers(options.headers || input?.headers || {});
    headers.set('x-access-reason', reason);
    headers.delete('x-identity-unmask-reason');
    if (unmask) headers.set('x-identity-unmask-reason', unmask);
    const check = () => {
      if (stamp !== generation || !context || expiresAt <= Date.now())
        throw abortError();
    };
    try {
      check();
      const response = await nativeFetch(input, {
        ...options,
        cache: 'no-store',
        headers,
        signal: controller.signal
      });
      check();
      if ([401, 403].includes(response.status) || response.redirected) {
        reset();
        refresh();
        throw abortError();
      }
      if (!response.ok) {
        unmask = '';
        invalidate();
        sync();
        status.textContent =
          'Accès refusé ou indisponible. Identités masquées.';
        throw abortError();
      }
      if (unmask)
        status.textContent = 'Levée d’identité active pour cette page.';
      return new Proxy(response, {
        get(target, key) {
          if (['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(key))
            return async (...args) => {
              check();
              try {
                let bodyTimer;
                let value;
                try {
                  value = await Promise.race([
                    target[key](...args),
                    new Promise((_, reject) => {
                      bodyTimer = root.setTimeout(
                        () => reject(abortError()),
                        12000
                      );
                    })
                  ]);
                } finally {
                  root.clearTimeout(bodyTimer);
                }
                check();
                return value;
              } catch (error) {
                if (stamp === generation && unmask) {
                  unmask = '';
                  invalidate();
                  sync();
                  status.textContent =
                    'Réponse indisponible. Identités masquées.';
                }
                throw error;
              }
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    } catch (error) {
      if (stamp === generation && unmask) {
        unmask = '';
        invalidate();
        sync();
      }
      throw error;
    } finally {
      root.clearTimeout(timeout);
      pending.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  };
  root.addEventListener('pagehide', () => {
    unmask = '';
    invalidate();
  });
  root.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reset();
      refresh();
    }
  });
  root.FacilitatProfessionalReview = {
    requestReason,
    reset,
    capture: () => generation,
    current: (stamp) => stamp === generation
  };
})(typeof window === 'undefined' ? null : window);
