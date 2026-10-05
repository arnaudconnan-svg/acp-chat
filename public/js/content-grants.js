(function (root) {
  'use strict';
  if (!root?.document) return;
  function localDateTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms),
      pad = (v, n = 2) => String(v).padStart(n, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  root.FacilitatContentGrants = {
    mount(container) {
      const panel = root.document.createElement('section');
      panel.className = 'card';
      function element(tag, text, parent = panel) {
        const el = root.document.createElement(tag);
        if (text) el.textContent = text;
        parent.append(el);
        return el;
      }
      element('h2', 'Acc\u00e8s de mon praticien');
      element(
        'p',
        'Seul un praticien affect\u00e9 et explicitement autoris\u00e9 peut lire les conversations publiques. Les conversations priv\u00e9es restent exclues. Une demande de contact ne donne aucun acc\u00e8s.'
      );
      const professional = element('select');
      professional.setAttribute('aria-label', 'Praticien affect\u00e9');
      const existing = element('p');
      existing.setAttribute('data-grant-current', '');
      const scope = element('select');
      scope.setAttribute('aria-label', 'Port\u00e9e de l\u2019autorisation');
      scope.add(
        new root.Option('Conversations choisies', 'conversation_specific')
      );
      scope.add(
        new root.Option(
          'P\u00e9riode : historique et futures conversations publiques',
          'accompaniment_period'
        )
      );
      const choices = element('fieldset');
      element('legend', 'Mes conversations publiques', choices);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      element(
        'label',
        'Fin de l\u2019autorisation, date et heure locales (' + timezone + ')'
      );
      const end = element('input');
      end.type = 'datetime-local';
      end.step = '0.001';
      end.setAttribute(
        'aria-label',
        'Fin de l\u2019autorisation en heure locale'
      );
      const summaryLabel = element('label'),
        summary = element('input', null, summaryLabel);
      summary.type = 'checkbox';
      summaryLabel.append(' Autoriser aussi la synth\u00e8se inter-session');
      const status = element('p');
      status.setAttribute('role', 'status');
      let grants = {},
        conversations = [],
        practitioners = [],
        busy = false;
      const buttons = [];
      function refreshButtons() {
        for (const b of buttons)
          b.disabled =
            busy ||
            !professional.value ||
            (b.dataset.method === 'PUT' &&
              !practitioners.find((p) => p.id === professional.value)
                ?.assigned);
      }
      function refreshScope() {
        choices.disabled = scope.value !== 'conversation_specific';
      }
      function showGrant() {
        const g = grants[professional.value];
        scope.value = g?.scope || 'conversation_specific';
        end.value = localDateTime(g?.endsAt);
        summary.checked = g?.allowIntersessionSummary === true;
        choices.replaceChildren();
        element('legend', 'Mes conversations publiques', choices);
        for (const c of conversations) {
          const label = element('label', null, choices),
            check = element('input', null, label);
          check.type = 'checkbox';
          check.value = c.id;
          check.checked = g?.conversationIds?.includes(c.id) === true;
          label.append(
            ' ' +
              (c.title || 'Conversation sans titre') +
              ' \u2014 ' +
              (c.updatedAt
                ? new Date(c.updatedAt).toLocaleString()
                : 'Date inconnue')
          );
          element('br', null, choices);
        }
        const selectedTitles = conversations
          .filter((c) => g?.conversationIds?.includes(c.id))
          .map((c) => c.title || 'Conversation sans titre')
          .join(', ');
        existing.textContent = g
          ? (g.active && g.endsAt <= Date.now()
              ? 'Autorisation expir\u00e9e'
              : g.active
                ? 'Autorisation active'
                : 'Autorisation r\u00e9voqu\u00e9e') +
            ' : ' +
            (g.scope === 'accompaniment_period'
              ? 'historique et futures conversations publiques'
              : 'conversations choisies : ' + selectedTitles) +
            '. Fin : ' +
            new Date(g.endsAt).toLocaleString() +
            ' (' +
            timezone +
            '). Synth\u00e8se inter-session : ' +
            (g.allowIntersessionSummary ? 'oui' : 'non') +
            '.'
          : 'Aucune autorisation enregistr\u00e9e.';
        refreshScope();
        refreshButtons();
      }
      async function reload() {
        const [grantRes, convRes] = await Promise.all([
          root.fetch('/api/account/content-grants'),
          root.fetch('/api/account/conversations')
        ]);
        if (!grantRes.ok || !convRes.ok)
          throw new Error('Acc\u00e8s indisponible.');
        const [data, list] = await Promise.all([
          grantRes.json(),
          convRes.json()
        ]);
        grants = data.grants || {};
        practitioners = data.practitioners || [];
        conversations = (list.conversations || []).filter(
          (c) => c.isPrivate !== true && !c.deletedAt
        );
        const selected = professional.value;
        professional.replaceChildren();
        for (const p of practitioners)
          professional.add(new root.Option(p.label, p.id));
        if (Array.from(professional.options).some((p) => p.value === selected))
          professional.value = selected;
        showGrant();
        refreshButtons();
        status.textContent = professional.options.length
          ? 'V\u00e9rifiez la port\u00e9e, la date et la synth\u00e8se avant de confirmer.'
          : 'Aucun praticien affect\u00e9. Acc\u00e8s ferm\u00e9.';
      }
      async function act(method) {
        if (busy) return;
        busy = true;
        for (const b of buttons) b.disabled = true;
        try {
          if (!professional.value)
            throw new Error('Choisissez un praticien affect\u00e9.');
          const endsAt = new Date(end.value).getTime();
          if (
            method === 'PUT' &&
            (!Number.isFinite(endsAt) || endsAt <= Date.now())
          )
            throw new Error('Choisissez une date et une heure de fin futures.');
          const response = await root.fetch(
            '/api/account/content-grants/' +
              encodeURIComponent(professional.value),
            {
              method,
              headers: { 'Content-Type': 'application/json' },
              body:
                method === 'PUT'
                  ? JSON.stringify({
                      scope: scope.value,
                      conversationIds:
                        scope.value === 'conversation_specific'
                          ? Array.from(
                              choices.querySelectorAll('input:checked')
                            ).map((c) => c.value)
                          : [],
                      endsAt,
                      allowIntersessionSummary: summary.checked
                    })
                  : undefined
            }
          );
          if (!response.ok)
            throw new Error(
              'Autorisation refus\u00e9e. V\u00e9rifiez la date et les conversations.'
            );
          await reload();
          status.textContent =
            method === 'PUT'
              ? 'Autorisation enregistr\u00e9e.'
              : 'Acc\u00e8s r\u00e9voqu\u00e9.';
        } catch (error) {
          status.textContent = error.message;
        } finally {
          busy = false;
          refreshButtons();
        }
      }
      for (const [text, method] of [
        ['Autoriser', 'PUT'],
        ['R\u00e9voquer', 'DELETE']
      ]) {
        const b = element('button', text);
        b.type = 'button';
        b.dataset.method = method;
        b.disabled = true;
        b.onclick = () => act(method);
        buttons.push(b);
      }
      professional.onchange = showGrant;
      scope.onchange = refreshScope;
      container.append(panel);
      reload().catch((error) => {
        status.textContent = error.message;
      });
      return panel;
    }
  };
})(typeof window === 'undefined' ? null : window);
