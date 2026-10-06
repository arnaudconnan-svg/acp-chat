(function (root) {
  'use strict';
  if (!root?.document) return;
  let reason = '',
    unmask = '';
  const nativeFetch = root.fetch.bind(root);
  const choices = {
    support_incident: 'Incident de support',
    security_review: 'Revue de s\u00e9curit\u00e9',
    user_request: 'Demande utilisateur',
    identity_verification: 'V\u00e9rification d\u2019identit\u00e9'
  };
  let requested;
  function requestReason() {
    if (reason) return Promise.resolve();
    if (requested) return requested;
    requested = new Promise((resolve) => {
      const panel = root.document.createElement('aside');
      panel.style.cssText =
        'padding:16px;background:#fff;color:#111;position:sticky;top:0;z-index:1000';
      panel.append(
        'Acc\u00e8s administrateur journalis\u00e9. Motif obligatoire : '
      );
      const select = root.document.createElement('select');
      select.setAttribute('aria-label', 'Motif administrateur');
      select.add(new root.Option('Choisir un motif', ''));
      for (const [code, label] of Object.entries(choices))
        select.add(new root.Option(label, code));
      select.onchange = () => {
        reason = select.value;
        if (reason) resolve();
      };
      panel.append(select);
      panel.append(
        ' Lev\u00e9e de pseudonymisation (\u00e9v\u00e9nement distinct) : '
      );
      const identity = root.document.createElement('select');
      identity.setAttribute(
        'aria-label',
        'Motif de lev\u00e9e de pseudonymisation'
      );
      identity.add(new root.Option('Conserver la pseudonymisation', ''));
      for (const [code, label] of Object.entries(choices))
        identity.add(new root.Option(label, code));
      identity.onchange = () => {
        unmask = identity.value;
      };
      panel.append(identity);
      root.document.body.prepend(panel);
    });
    return requested;
  }
  root.fetch = async function (input, options = {}) {
    const url = new URL(
      typeof input === 'string' ? input : input.url,
      root.location.origin
    );
    if (
      url.origin === root.location.origin &&
      url.pathname.startsWith('/api/admin/') &&
      !['/api/admin/session', '/api/admin/login', '/api/admin/logout'].includes(
        url.pathname
      )
    ) {
      await requestReason();
      const headers = new root.Headers(options.headers || input?.headers || {});
      headers.set('x-access-reason', reason);
      if (unmask) headers.set('x-identity-unmask-reason', unmask);
      return nativeFetch(input, { ...options, headers });
    }
    return nativeFetch(input, options);
  };
  root.FacilitatProfessionalReview = { requestReason };
})(typeof window === 'undefined' ? null : window);
