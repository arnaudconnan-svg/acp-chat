(function (root) {
  'use strict';
  if (!root?.document) return;
  root.FacilitatContentGrants = {
    mount(container) {
      const panel = root.document.createElement('section');
      panel.className = 'card';
      const title = root.document.createElement('h2');
      title.textContent = 'Acc\u00e8s de mon praticien';
      panel.append(title);
      const notice = root.document.createElement('p');
      notice.textContent =
        'Autorisez uniquement un praticien affect\u00e9. Les conversations priv\u00e9es restent exclues. Une demande de contact ne donne aucun acc\u00e8s.';
      panel.append(notice);
      const professional = root.document.createElement('select');
      professional.setAttribute('aria-label', 'Praticien affect\u00e9');
      panel.append(professional);
      const scope = root.document.createElement('select');
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
      panel.append(scope);
      const ids = root.document.createElement('input');
      ids.placeholder =
        'Identifiants des conversations, s\u00e9par\u00e9s par des virgules';
      ids.setAttribute('aria-label', 'Conversations choisies');
      panel.append(ids);
      const end = root.document.createElement('input');
      end.type = 'date';
      end.setAttribute('aria-label', 'Fin de l\u2019autorisation');
      panel.append(end);
      const label = root.document.createElement('label'),
        summary = root.document.createElement('input');
      summary.type = 'checkbox';
      label.append(summary, ' Autoriser aussi la synth\u00e8se inter-session');
      panel.append(label);
      const status = root.document.createElement('p');
      status.setAttribute('role', 'status');
      panel.append(status);
      async function act(method) {
        try {
          if (!professional.value)
            throw new Error('Choisissez un praticien affect\u00e9.');
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
                      conversationIds: ids.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                      endsAt: Date.parse(end.value + 'T23:59:59Z'),
                      allowIntersessionSummary: summary.checked
                    })
                  : undefined
            }
          );
          if (!response.ok)
            throw new Error(
              'Autorisation refus\u00e9e. V\u00e9rifiez la date et les conversations.'
            );
          status.textContent =
            method === 'PUT'
              ? 'Autorisation enregistr\u00e9e.'
              : 'Acc\u00e8s r\u00e9voqu\u00e9.';
        } catch (error) {
          status.textContent = error.message;
        }
      }
      for (const [text, method] of [
        ['Autoriser', 'PUT'],
        ['R\u00e9voquer', 'DELETE']
      ]) {
        const button = root.document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.onclick = () => act(method);
        panel.append(button);
      }
      container.append(panel);
      root
        .fetch('/api/account/content-grants')
        .then(async (response) => {
          if (!response.ok) throw new Error();
          const data = await response.json();
          for (const p of data.practitioners || [])
            professional.add(new root.Option(p.label, p.id));
          status.textContent = professional.options.length
            ? 'S\u00e9lectionnez le p\u00e9rim\u00e8tre et la date de fin.'
            : 'Aucun praticien affect\u00e9. Acc\u00e8s ferm\u00e9.';
        })
        .catch(() => {
          status.textContent = 'Acc\u00e8s indisponible.';
        });
      return panel;
    }
  };
})(typeof window === 'undefined' ? null : window);
