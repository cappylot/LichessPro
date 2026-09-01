const root = document.getElementById('root');

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const clear = (node) => {
  while (node.firstChild) node.firstChild.remove();
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

function formatClock(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const minutes = (s) => (s % 60 === 0 ? `${s / 60} min` : `${s}s`);

// ---------------------------------------------------------------------------
// Create view
// ---------------------------------------------------------------------------

function renderCreate() {
  const periods = [{ afterMove: 40, bonus: 1800 }];

  const baseInput = el('input', { type: 'number', value: '90', min: '1', max: '180', step: '1' });
  const incInput = el('input', { type: 'number', value: '30', min: '0', max: '60', step: '1' });
  const colorSelect = el(
    'select',
    {},
    el('option', { value: 'random', textContent: 'Random' }),
    el('option', { value: 'white', textContent: 'You play White' }),
    el('option', { value: 'black', textContent: 'You play Black' }),
  );
  const ratedSelect = el(
    'select',
    {},
    el('option', { value: 'false', textContent: 'Casual' }),
    el('option', { value: 'true', textContent: 'Rated' }),
  );

  const periodList = el('div');
  const error = el('div');

  function drawPeriods() {
    clear(periodList);
    periods.forEach((period, index) => {
      const move = el('input', { type: 'number', value: String(period.afterMove), min: '1', max: '300' });
      const bonus = el('input', { type: 'number', value: String(period.bonus / 60), min: '1', max: '180' });
      move.addEventListener('input', () => {
        period.afterMove = Number.parseInt(move.value, 10);
      });
      bonus.addEventListener('input', () => {
        period.bonus = Math.round(Number.parseFloat(bonus.value) * 60);
      });
      const remove = el('button', { className: 'secondary', type: 'button', textContent: 'Remove' });
      remove.addEventListener('click', () => {
        periods.splice(index, 1);
        drawPeriods();
      });
      periodList.append(
        el(
          'div',
          { className: 'period-row' },
          el('div', {}, el('label', { textContent: 'After move' }), move),
          el('div', {}, el('label', { textContent: 'Add (minutes)' }), bonus),
          remove,
        ),
      );
    });
  }
  drawPeriods();

  const addPeriod = el('button', { className: 'secondary', type: 'button', textContent: '+ Add another period' });
  addPeriod.addEventListener('click', () => {
    periods.push({ afterMove: 60, bonus: 900 });
    drawPeriods();
  });

  const submit = el('button', { type: 'submit', textContent: 'Create match' });

  const form = el(
    'form',
    { className: 'card' },
    el('h2', { textContent: 'Time control' }),
    el(
      'div',
      { className: 'grid' },
      el('div', {}, el('label', { textContent: 'Base time (minutes)' }), baseInput),
      el('div', {}, el('label', { textContent: 'Increment (seconds)' }), incInput),
      el('div', {}, el('label', { textContent: 'Your colour' }), colorSelect),
      el('div', {}, el('label', { textContent: 'Rating' }), ratedSelect),
    ),
    el('h2', { textContent: 'Bonus periods', style: 'margin-top:22px' }),
    el('p', {
      className: 'muted',
      textContent:
        'Each player receives the bonus the moment they complete that move — the way a DGT clock starts a new period.',
    }),
    periodList,
    addPeriod,
    el('div', { style: 'margin-top:22px' }, submit),
    error,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(error);
    submit.disabled = true;
    try {
      const spec = {
        base: Math.round(Number.parseFloat(baseInput.value) * 60),
        increment: Number.parseInt(incInput.value, 10),
        periods,
      };
      const created = await api('/api/matches', {
        method: 'POST',
        body: JSON.stringify({ spec, rated: ratedSelect.value === 'true', color: colorSelect.value }),
      });
      window.location.href = `/m/${created.id}`;
    } catch (err) {
      error.append(el('div', { className: 'notice bad', textContent: err.message }));
      submit.disabled = false;
    }
  });

  clear(root).append(
    el('h1', { textContent: 'Play a multi-period game on Lichess' }),
    el('p', {
      className: 'muted',
      style: 'margin-top:0;margin-bottom:20px',
      textContent:
        'Lichess challenges only allow base time plus increment. This app plays the arbiter: it watches your game live and hands each player their extra time the moment they reach the control move.',
    }),
    form,
  );
}

// ---------------------------------------------------------------------------
// Match view
// ---------------------------------------------------------------------------

function seatCard(match, seatKey, you, onSignIn) {
  const seat = match.seats[seatKey];
  const label = seatKey === 'a' ? 'Player 1 (challenger)' : 'Player 2';

  if (seat) {
    return el(
      'div',
      { className: 'seat' },
      el('span', { className: 'dot on' }),
      el(
        'div',
        { className: 'who' },
        el('div', { className: 'name' }, `${seat.title ? `${seat.title} ` : ''}${seat.username}`),
        el('div', { className: 'muted' }, label + (you === seatKey ? ' — this is you' : '')),
      ),
    );
  }

  const button = el('button', { textContent: 'Sign in with Lichess' });
  button.addEventListener('click', onSignIn);
  return el(
    'div',
    { className: 'seat' },
    el('span', { className: 'dot' }),
    el('div', { className: 'who' }, el('div', { className: 'name muted' }, 'Empty'), el('div', { className: 'muted' }, label)),
    button,
  );
}

/**
 * Fallback for when the app is not reachable from the other player's browser:
 * they generate a Lichess API token and you paste it here. Avoids needing a
 * tunnel or a public URL just to complete an OAuth redirect.
 */
function tokenPasteCard(match, createUrl) {
  const input = el('input', {
    type: 'password',
    placeholder: 'lip_...',
    autocomplete: 'off',
    spellcheck: false,
  });
  const submit = el('button', { className: 'secondary', textContent: 'Add player from token' });
  const feedback = el('div');

  submit.addEventListener('click', async () => {
    clear(feedback);
    const token = input.value.trim();
    if (!token) return;
    submit.disabled = true;
    try {
      const result = await api(`/api/matches/${match.id}/token`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      input.value = ''; // never leave a credential sitting in the DOM
      if (result.warning) feedback.append(el('div', { className: 'notice', textContent: result.warning }));
    } catch (err) {
      feedback.append(el('div', { className: 'notice bad', textContent: err.message }));
    } finally {
      submit.disabled = false;
    }
  });

  return el(
    'details',
    {},
    el('summary', { textContent: 'Or add a player with an API token (no public URL needed)' }),
    el('p', { className: 'muted' }, 'Use this when your opponent cannot open this page — for example when it is only running on your own machine.'),
    el(
      'ol',
      { className: 'muted', style: 'padding-left:20px' },
      el(
        'li',
        {},
        'Send them ',
        el('a', { href: createUrl, target: '_blank', rel: 'noopener', textContent: 'this Lichess link' }),
        ', which pre-selects the two permissions needed. They click Create and copy the token.',
      ),
      el('li', {}, 'They send you the token privately. Paste it below.'),
      el('li', {}, 'Once the game is over they should revoke it at lichess.org → Preferences → API access tokens.'),
    ),
    el('div', {
      className: 'notice',
      textContent:
        'A token is a credential: whoever holds it can play moves and resign games on that account until it is revoked. Only do this with someone you trust, and send it over a private channel.',
    }),
    el('div', { className: 'row' }, input, submit),
    feedback,
  );
}

function deliveriesTable(match) {
  const rows = Object.entries(match.deliveries);
  if (rows.length === 0) {
    return el('p', { className: 'muted', textContent: 'No bonus has come due yet.' });
  }

  const body = el('tbody');
  for (const [key, rec] of rows) {
    const pct = rec.planned ? Math.round((rec.deliveredSeconds / rec.planned) * 100) : 0;
    let status;
    let cls = '';
    if (rec.error) {
      status = `Failed: ${rec.error}`;
      cls = 'error';
    } else if (rec.done) {
      status = rec.verified ? 'Delivered ✓ verified on clock' : 'Delivered (clock change not observable)';
    } else {
      status = `Sending ${rec.calls}/${Math.ceil(rec.planned / 60)} calls…`;
    }

    body.append(
      el(
        'tr',
        {},
        el('td', {}, el('span', { className: `swatch ${rec.color}` }), rec.color),
        el('td', {}, rec.reason ?? key),
        el('td', {}, minutes(rec.target)),
        el(
          'td',
          {},
          el('div', { className: 'bar' }, el('span', { style: `width:${Math.min(100, pct)}%` })),
          el('div', { className: `muted ${cls}`, style: 'margin-top:4px' }, status),
        ),
      ),
    );
  }

  return el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { textContent: 'Player' }),
        el('th', { textContent: 'Trigger' }),
        el('th', { textContent: 'Bonus' }),
        el('th', { textContent: 'Delivery' }),
      ),
    ),
    body,
  );
}

function livePanel(match) {
  const { clocks, sideToMove, movesCompleted, players } = match;
  const name = (color) => players?.[color]?.username ?? color;

  const clockBox = (color) =>
    el(
      'div',
      { className: `clock${sideToMove === color && match.status === 'live' ? ' turn' : ''}` },
      el('div', { className: 'side' }, el('span', { className: `swatch ${color}` }), name(color)),
      el('div', { className: 'time', textContent: formatClock(clocks?.[color]) }),
      el('div', { className: 'muted', textContent: `move ${movesCompleted?.[color] ?? 0} completed` }),
    );

  return el(
    'div',
    { className: 'card' },
    el(
      'div',
      { className: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
      el('h2', { style: 'margin:0', textContent: 'Live game' }),
      match.gameUrl && el('a', { href: match.gameUrl, target: '_blank', rel: 'noopener', textContent: 'Open on Lichess ↗' }),
    ),
    el('div', { className: 'clocks' }, clockBox('white'), clockBox('black')),
    el('p', {
      className: 'muted',
      style: 'margin:0 0 16px',
      textContent: `Ply ${match.plies} · ${match.gameStatus ?? 'starting'}${match.winner ? ` · ${match.winner} won` : ''}`,
    }),
    el('h2', { textContent: 'Bonus delivery' }),
    deliveriesTable(match),
  );
}

function eventLog(match) {
  const list = el('div', { className: 'log' });
  for (const event of [...match.events].reverse()) {
    list.append(
      el(
        'div',
        { className: event.level },
        el('time', { textContent: new Date(event.at).toLocaleTimeString() }),
        event.message,
      ),
    );
  }
  return el(
    'details',
    {},
    el('summary', { textContent: `Arbiter log (${match.events.length})` }),
    match.events.length ? list : el('p', { className: 'muted', textContent: 'Nothing logged yet.' }),
  );
}

function renderMatch(state) {
  const { match, you, tokenCreateUrl } = state;
  const shareUrl = `${window.location.origin}/m/${match.id}`;
  const bothIn = Boolean(match.seats.a && match.seats.b);

  const statusPill = el('span', {
    className: `pill${match.status === 'live' ? ' live' : ''}${match.error ? ' error' : ''}`,
    textContent: match.status.replace('-', ' '),
  });

  const nodes = [
    el(
      'div',
      { className: 'row', style: 'justify-content:space-between;align-items:baseline' },
      el('h1', { style: 'margin:0', textContent: match.specLabel }),
      statusPill,
    ),
    el('p', {
      className: 'muted',
      style: 'margin-top:4px',
      textContent: `${match.rated ? 'Rated' : 'Casual'} · challenger plays ${match.color}`,
    }),
  ];

  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'same-account') {
    nodes.push(
      el('div', {
        className: 'notice bad',
        textContent:
          'Both seats must be different Lichess accounts. Time can only be added to an opponent, so each player needs the other to authorise the app. Ask your friend to open this link and sign in with their own account.',
      }),
    );
  } else if (params.get('error')) {
    nodes.push(el('div', { className: 'notice bad', textContent: `Sign-in failed: ${params.get('error')}` }));
  }
  if (match.error) nodes.push(el('div', { className: 'notice bad', textContent: match.error }));

  // Players
  const signIn = () => {
    window.location.href = `/auth/login?match=${encodeURIComponent(match.id)}`;
  };
  const playersCard = el(
    'div',
    { className: 'card' },
    el('h2', { textContent: 'Players' }),
    seatCard(match, 'a', you, signIn),
    seatCard(match, 'b', you, signIn),
  );

  if (!bothIn) {
    const input = el('input', { type: 'text', value: shareUrl, readOnly: true });
    const copy = el('button', { className: 'secondary', textContent: 'Copy' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        input.select();
        document.execCommand?.('copy');
      }
      copy.textContent = 'Copied!';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1500);
    });
    playersCard.append(
      el('h2', { style: 'margin-top:20px', textContent: 'Invite your opponent' }),
      el('p', { className: 'muted', style: 'margin-top:0' }, 'Send this link. They open it and sign in with their own Lichess account.'),
      el('div', { className: 'share' }, input, copy),
      tokenPasteCard(match, tokenCreateUrl),
    );
  }
  nodes.push(playersCard);

  // Start
  if (!match.gameId) {
    const start = el('button', { textContent: 'Create the game on Lichess', disabled: !bothIn || !you });
    const err = el('div');
    start.addEventListener('click', async () => {
      start.disabled = true;
      clear(err);
      try {
        await api(`/api/matches/${match.id}/start`, { method: 'POST' });
      } catch (e) {
        err.append(el('div', { className: 'notice bad', textContent: e.message }));
        start.disabled = false;
      }
    });

    const hint = !bothIn
      ? 'Waiting for both players to sign in.'
      : !you
        ? 'Only the two players can start this match.'
        : 'The challenge is created and accepted automatically, then the arbiter starts watching.';

    nodes.push(el('div', { className: 'card' }, el('h2', { textContent: 'Start' }), el('p', { className: 'muted', style: 'margin-top:0' }, hint), start, err));
  } else {
    nodes.push(livePanel(match));
  }

  // Advanced
  if (match.status === 'live' && you) {
    const color = el('select', {}, el('option', { value: 'white', textContent: 'White' }), el('option', { value: 'black', textContent: 'Black' }));
    const secs = el('input', { type: 'number', value: '60', min: '5', max: '10800' });
    const go = el('button', { className: 'secondary', textContent: 'Add time' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await api(`/api/matches/${match.id}/topup`, {
          method: 'POST',
          body: JSON.stringify({ color: color.value, seconds: Number.parseInt(secs.value, 10) }),
        });
      } finally {
        go.disabled = false;
      }
    });
    nodes.push(
      el(
        'div',
        { className: 'card' },
        el(
          'details',
          {},
          el('summary', { textContent: 'Manual override' }),
          el('p', { className: 'muted' }, 'Escape hatch if a scheduled bonus did not land. Delivered in 60-second calls, same as the automatic one.'),
          el('div', { className: 'row' }, color, secs, go),
        ),
      ),
    );
  }

  nodes.push(el('div', { className: 'card' }, eventLog(match)));
  clear(root).append(...nodes);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function subscribe(matchId) {
  const source = new EventSource(`/api/matches/${matchId}/stream`);
  source.addEventListener('message', (event) => {
    try {
      renderMatch(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to render match', err);
    }
  });
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; nothing to do but let it.
  });
}

const matchId = window.location.pathname.startsWith('/m/') ? window.location.pathname.slice(3) : null;

if (!matchId) {
  renderCreate();
} else {
  api(`/api/matches/${matchId}`)
    .then((state) => {
      renderMatch(state);
      subscribe(matchId);
    })
    .catch((err) => {
      clear(root).append(el('div', { className: 'notice bad', textContent: err.message }));
    });
}
