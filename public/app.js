/**
 * LichessPro front end.
 *
 * Two pages, both served from index.html:
 *   /       create a match
 *   /m/:id  run it — three guided steps, then the live game panel
 *
 * The match page builds its DOM once per phase and then PATCHES it in place.
 * That matters: during a bonus delivery the server pushes an update after every
 * one of the 30 add-time calls, roughly every 400ms. Rebuilding the page on each
 * one would reset scroll positions, close open sections, wipe anything being
 * typed, and make transitions impossible.
 */

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element. Keys containing a dash (aria-*, data-*, role) go through
 * setAttribute; everything else is assigned as a DOM property.
 */
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.includes('-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  append(node, children);
  return node;
};

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clear = (node) => {
  while (node.firstChild) node.firstChild.remove();
  return node;
};

const fill = (node, ...children) => append(clear(node), children);

/** Set textContent only when it changed, so patching never disturbs the DOM. */
const setText = (node, text) => {
  const next = String(text);
  if (node.textContent !== next) node.textContent = next;
};

const setClass = (node, name, on) => node.classList.toggle(name, Boolean(on));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatClock(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const duration = (seconds) => {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds > 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const displayName = (seat) => (seat ? `${seat.title ? `${seat.title} ` : ''}${seat.username}` : '');

function copyButton(label, getText, { className = 'btn ghost' } = {}) {
  const button = el('button', { className, type: 'button', textContent: label });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      const previous = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('is-done');
      setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('is-done');
      }, 1600);
    } catch {
      button.textContent = 'Press Ctrl+C to copy';
    }
  });
  return button;
}

// ---------------------------------------------------------------------------
// Create page
// ---------------------------------------------------------------------------

const PRESETS = [
  {
    id: 'fide',
    name: 'FIDE Classical',
    detail: '90 min + 30s, then +30 min at move 40',
    spec: { base: 90, increment: 30, periods: [{ afterMove: 40, bonus: 30 }] },
  },
  {
    id: 'test',
    name: 'Quick test',
    detail: '3 min + 2s, then +1 min at move 2',
    hint: 'Proves the whole bonus path in about two minutes. Run this first.',
    spec: { base: 3, increment: 2, periods: [{ afterMove: 2, bonus: 1 }] },
  },
];

function renderCreate(root) {
  let periods = [];

  const baseInput = el('input', { type: 'number', id: 'f-base', min: '1', max: '180', step: '1' });
  const incInput = el('input', { type: 'number', id: 'f-inc', min: '0', max: '60', step: '1' });
  const colorSelect = el(
    'select',
    { id: 'f-color' },
    el('option', { value: 'random', textContent: 'Random' }),
    el('option', { value: 'white', textContent: 'You play White' }),
    el('option', { value: 'black', textContent: 'You play Black' }),
  );
  const ratedSelect = el(
    'select',
    { id: 'f-rated' },
    el('option', { value: 'false', textContent: 'Casual' }),
    el('option', { value: 'true', textContent: 'Rated' }),
  );

  const periodList = el('div', { className: 'period-list' });
  const presetRow = el('div', { className: 'presets' });
  const presetHint = el('p', { className: 'hint' });
  const errorSlot = el('div');

  const markCustom = () => {
    for (const child of presetRow.children) child.classList.remove('is-active');
    setText(presetHint, '');
  };

  function drawPeriods() {
    fill(
      periodList,
      periods.map((period, index) => {
        const move = el('input', { type: 'number', value: String(period.afterMove), min: '1', max: '300' });
        const bonus = el('input', { type: 'number', value: String(period.bonus), min: '1', max: '180' });
        move.addEventListener('input', () => {
          period.afterMove = Number.parseInt(move.value, 10);
          markCustom();
        });
        bonus.addEventListener('input', () => {
          period.bonus = Number.parseFloat(bonus.value);
          markCustom();
        });
        const remove = el('button', { className: 'btn ghost icon', type: 'button', textContent: '✕' });
        remove.setAttribute('aria-label', `Remove bonus period ${index + 1}`);
        remove.addEventListener('click', () => {
          periods.splice(index, 1);
          markCustom();
          drawPeriods();
        });
        return el(
          'div',
          { className: 'period-row' },
          el('div', { className: 'field' }, el('label', { textContent: 'After move' }), move),
          el('div', { className: 'field' }, el('label', { textContent: 'Add minutes' }), bonus),
          remove,
        );
      }),
      periods.length === 0
        ? el('p', { className: 'hint', textContent: 'No bonus periods — this is a plain base + increment game.' })
        : null,
    );
  }

  function applyPreset(preset) {
    baseInput.value = String(preset.spec.base);
    incInput.value = String(preset.spec.increment);
    periods = preset.spec.periods.map((p) => ({ ...p }));
    drawPeriods();
    for (const child of presetRow.children) child.classList.toggle('is-active', child.dataset.preset === preset.id);
    setText(presetHint, preset.hint ?? '');
  }

  for (const preset of PRESETS) {
    const card = el(
      'button',
      { className: 'preset', type: 'button' },
      el('span', { className: 'preset-name', textContent: preset.name }),
      el('span', { className: 'preset-detail', textContent: preset.detail }),
    );
    card.dataset.preset = preset.id;
    card.addEventListener('click', () => applyPreset(preset));
    presetRow.append(card);
  }

  for (const input of [baseInput, incInput]) input.addEventListener('input', markCustom);

  const addPeriod = el('button', { className: 'btn ghost', type: 'button', textContent: '+ Add a period' });
  addPeriod.addEventListener('click', () => {
    periods.push({ afterMove: 60, bonus: 15 });
    markCustom();
    drawPeriods();
  });

  const submit = el('button', { className: 'btn primary lg', type: 'submit', textContent: 'Create match' });

  const form = el(
    'form',
    { className: 'card stack' },
    el('div', { className: 'field' }, el('span', { className: 'label', textContent: 'Start from a preset' }), presetRow),
    presetHint,
    el('hr', { className: 'rule' }),
    el(
      'div',
      { className: 'grid' },
      el('div', { className: 'field' }, el('label', { htmlFor: 'f-base', textContent: 'Base time (minutes)' }), baseInput),
      el('div', { className: 'field' }, el('label', { htmlFor: 'f-inc', textContent: 'Increment (seconds)' }), incInput),
      el('div', { className: 'field' }, el('label', { htmlFor: 'f-color', textContent: 'Your colour' }), colorSelect),
      el('div', { className: 'field' }, el('label', { htmlFor: 'f-rated', textContent: 'Rating' }), ratedSelect),
    ),
    el(
      'div',
      { className: 'field' },
      el('span', { className: 'label', textContent: 'Bonus periods' }),
      el('p', {
        className: 'hint',
        textContent:
          'Each player gets the bonus the moment they complete that move — the way a DGT clock starts a new period.',
      }),
      periodList,
      addPeriod,
    ),
    el('div', { className: 'actions' }, submit),
    errorSlot,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    submit.disabled = true;
    try {
      const created = await api('/api/matches', {
        method: 'POST',
        body: JSON.stringify({
          spec: {
            base: Math.round(Number.parseFloat(baseInput.value) * 60),
            increment: Number.parseInt(incInput.value, 10),
            periods: periods.map((p) => ({ afterMove: p.afterMove, bonus: Math.round(p.bonus * 60) })),
          },
          rated: ratedSelect.value === 'true',
          color: colorSelect.value,
        }),
      });
      window.location.href = `/m/${created.id}`;
    } catch (err) {
      errorSlot.append(el('div', { className: 'notice bad', textContent: err.message }));
      submit.disabled = false;
    }
  });

  applyPreset(PRESETS[0]);

  fill(
    root,
    el('div', { className: 'page-head' },
      el('h1', { textContent: 'Multi-period chess on Lichess' }),
      el('p', {
        className: 'lede',
        textContent:
          'Lichess challenges only allow base time plus increment. This app plays the arbiter: it watches your game and hands each player their extra time the moment they reach the control move.',
      }),
    ),
    form,
  );
}

// ---------------------------------------------------------------------------
// Match page — step 1: the host
// ---------------------------------------------------------------------------

function buildHostStep(matchId) {
  const body = el('div');
  let key = null;

  const signIn = el('button', { className: 'btn primary', type: 'button', textContent: 'Sign in with Lichess' });
  signIn.addEventListener('click', () => {
    signIn.disabled = true;
    window.location.href = `/auth/login?match=${encodeURIComponent(matchId)}`;
  });

  return {
    body,
    update(match) {
      const seat = match.seats.a;
      const next = seat ? `in:${seat.userId}` : 'out';
      if (key === next) return;
      key = next;

      if (seat) {
        fill(body, playerRow(seat, 'You', 'challenger'));
      } else {
        fill(
          body,
          el('p', { className: 'hint', textContent: 'Opens lichess.org so you can authorise this app on your own account.' }),
          signIn,
        );
      }
    },
  };
}

function playerRow(seat, badge, role) {
  return el(
    'div',
    { className: 'player' },
    el(
      'div',
      { className: 'player-id' },
      el('span', { className: 'player-name', textContent: displayName(seat) }),
      el('span', { className: 'player-role', textContent: role }),
    ),
    badge ? el('span', { className: 'badge', textContent: badge }) : null,
  );
}

// ---------------------------------------------------------------------------
// Match page — step 2: the opponent
// ---------------------------------------------------------------------------

function buildOpponentStep(matchId) {
  const body = el('div');
  let key = null;

  const input = el('input', {
    className: 'token-input',
    type: 'password',
    id: 'opponent-token',
    placeholder: 'lip_…',
    autocomplete: 'off',
    spellcheck: false,
  });
  const submit = el('button', { className: 'btn primary', type: 'button', textContent: 'Add opponent' });
  const feedback = el('div', { className: 'feedback', role: 'status', 'aria-live': 'polite' });

  const send = async () => {
    const token = input.value.trim();
    clear(feedback);
    if (!token) {
      input.focus();
      return;
    }
    submit.disabled = true;
    input.disabled = true;
    try {
      const result = await api(`/api/matches/${matchId}/token`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      input.value = ''; // never leave a credential sitting in the DOM
      if (result.warning) feedback.append(el('div', { className: 'notice warn', textContent: result.warning }));
    } catch (err) {
      feedback.append(el('div', { className: 'notice bad', textContent: err.message }));
    } finally {
      submit.disabled = false;
      input.disabled = false;
    }
  };

  submit.addEventListener('click', send);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  });

  return {
    body,
    update(match, tokenCreateUrl) {
      const seat = match.seats.b;
      const next = seat ? `in:${seat.userId}` : 'out';
      if (key === next) return;
      key = next;

      if (seat) {
        fill(body, playerRow(seat, null, 'opponent'), feedback);
        return;
      }

      const linkField = el('input', {
        className: 'token-input',
        type: 'text',
        id: 'token-link',
        readOnly: true,
        value: tokenCreateUrl,
      });
      // Select the whole URL on focus, so it can still be copied by hand if the
      // clipboard API is unavailable — as it is on some non-secure origins, and
      // this app normally runs on plain http://localhost.
      linkField.addEventListener('focus', () => {
        linkField.select();
        linkField.scrollLeft = 0; // keep the domain in view, not the query string
      });

      fill(
        body,
        el('p', {
          className: 'hint',
          textContent: 'Your opponent generates a token and sends it to you. They never need to open this app.',
        }),
        el(
          'div',
          { className: 'field' },
          el('label', { className: 'label', htmlFor: 'token-link', textContent: '1 · Send your opponent this link' }),
          el(
            'div',
            { className: 'token-entry' },
            linkField,
            copyButton('Copy link', () => tokenCreateUrl, { className: 'btn secondary' }),
          ),
          el('p', {
            className: 'hint sub',
            textContent:
              'It opens the Lichess token page with both required permissions already ticked. They press Create and send you the token it shows.',
          }),
        ),
        el(
          'div',
          { className: 'field' },
          el('label', {
            className: 'label',
            htmlFor: 'opponent-token',
            textContent: '2 · Paste the token they send back',
          }),
          el('div', { className: 'token-entry' }, input, submit),
        ),
        feedback,
        el('p', {
          className: 'fine',
          textContent:
            'A token is a credential: whoever holds it can play moves and resign games on that account until it is revoked. Only do this with someone you trust, over a private channel.',
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Match page — step 3: start
// ---------------------------------------------------------------------------

function buildStartStep(matchId) {
  const body = el('div');
  const hint = el('p', { className: 'hint' });
  const errorSlot = el('div');
  const start = el('button', { className: 'btn primary lg', type: 'button', textContent: 'Create the game on Lichess' });

  start.addEventListener('click', async () => {
    start.disabled = true;
    clear(errorSlot);
    setText(start, 'Creating…');
    try {
      await api(`/api/matches/${matchId}/start`, { method: 'POST' });
    } catch (err) {
      errorSlot.append(el('div', { className: 'notice bad', textContent: err.message }));
      setText(start, 'Create the game on Lichess');
      start.disabled = false;
    }
  });

  const summary = el('dl', { className: 'summary' });
  fill(body, summary, start, hint, errorSlot);

  return {
    body,
    update(match, you) {
      const ready = Boolean(match.seats.a && match.seats.b);
      fill(
        summary,
        summaryRow('Time control', match.specLabel),
        summaryRow('Rated', match.rated ? 'Rated' : 'Casual'),
        summaryRow('Colours', colourSummary(match)),
      );
      start.disabled = !ready || !you;
      setText(
        hint,
        !ready
          ? 'Complete the two steps above first.'
          : !you
            ? 'Only the host of this match can start it.'
            : 'The challenge is created and accepted automatically, then the arbiter starts watching.',
      );
    },
  };
}

function summaryRow(term, value) {
  return el('div', { className: 'summary-row' }, el('dt', { textContent: term }), el('dd', { textContent: value }));
}

function colourSummary(match) {
  const capital = (word) => word[0].toUpperCase() + word.slice(1);
  if (!match.seats.a || !match.seats.b) {
    return match.color === 'random' ? 'Random colours' : `Host plays ${capital(match.color)}`;
  }
  const host = displayName(match.seats.a);
  const other = displayName(match.seats.b);
  if (match.color === 'random') return `Random — ${host} vs ${other}`;
  const opposite = match.color === 'white' ? 'Black' : 'White';
  return `${host} as ${capital(match.color)}, ${other} as ${opposite}`;
}

// ---------------------------------------------------------------------------
// Match page — live game
// ---------------------------------------------------------------------------

const LOW_CLOCK_MS = 60_000;

const STATUS_TEXT = {
  created: 'starting',
  started: 'in progress',
  outoftime: 'flagged',
  timeout: 'timed out',
  mate: 'checkmate',
  resign: 'resignation',
  aborted: 'aborted',
  stalemate: 'stalemate',
  draw: 'draw',
};

function buildClock(color) {
  const time = el('div', { className: 'clock-time', textContent: '—' });
  const name = el('div', { className: 'clock-name', textContent: color });
  const moves = el('div', { className: 'clock-moves', textContent: 'move 0' });
  const root = el(
    'div',
    { className: `clock clock-${color}` },
    el('div', { className: 'clock-head' }, el('span', { className: `swatch ${color}` }), name),
    time,
    moves,
  );
  return {
    root,
    update(match) {
      const ms = match.clocks?.[color];
      setText(time, formatClock(ms));
      setText(name, match.players?.[color]?.username ?? color);
      setText(moves, `move ${match.movesCompleted?.[color] ?? 0} completed`);
      setClass(root, 'is-turn', match.sideToMove === color && match.gameStatus === 'started');
      setClass(root, 'is-low', typeof ms === 'number' && ms < LOW_CLOCK_MS);
    },
  };
}

function buildDeliveries() {
  const list = el('div', { className: 'deliveries', role: 'status', 'aria-live': 'polite' });
  const empty = el('p', { className: 'hint', textContent: 'No bonus has come due yet.' });
  const rows = new Map();

  return {
    root: list,
    update(match) {
      const entries = Object.entries(match.deliveries ?? {});
      if (entries.length === 0) {
        if (!empty.isConnected) fill(list, empty);
        return;
      }
      if (empty.isConnected) empty.remove();

      for (const [key, rec] of entries) {
        let row = rows.get(key);
        if (!row) {
          row = buildDeliveryRow(rec);
          rows.set(key, row);
          list.append(row.root);
        }
        row.update(rec);
      }
    },
  };
}

function buildDeliveryRow(rec) {
  const title = el('div', { className: 'delivery-title' });
  const status = el('div', { className: 'delivery-status' });
  const barFill = el('span', { className: 'bar-fill' });
  const bar = el('div', { className: 'bar' }, barFill);
  const root = el(
    'div',
    { className: `delivery delivery-${rec.color}` },
    el('div', { className: 'delivery-head' }, el('span', { className: `swatch ${rec.color}` }), title),
    bar,
    status,
  );

  return {
    root,
    update(next) {
      const calls = Math.max(1, Math.ceil((next.planned ?? next.target) / 60));
      const pct = next.planned ? Math.min(100, Math.round((next.deliveredSeconds / next.planned) * 100)) : 0;
      const who = next.color[0].toUpperCase() + next.color.slice(1);
      setText(title, [who, `+${duration(next.target)}`, next.reason].filter(Boolean).join(' · '));
      barFill.style.width = `${pct}%`;

      setClass(root, 'is-done', Boolean(next.done));
      setClass(root, 'is-failed', Boolean(next.error));
      setClass(root, 'is-verified', next.verified === true);

      if (next.error) setText(status, `Failed: ${next.error}`);
      else if (next.done && next.verified) setText(status, `Delivered — ${duration(next.deliveredSeconds)} confirmed on the clock`);
      else if (next.done) setText(status, `Delivered ${duration(next.deliveredSeconds)} (clock change not observable)`);
      else setText(status, `Sending… ${next.calls}/${calls} calls, ${duration(next.deliveredSeconds)} so far`);
    },
  };
}

function buildLog() {
  const list = el('div', { className: 'log' });
  const seen = new Set();
  const details = el(
    'details',
    { className: 'panel' },
    el('summary', {}, el('span', { className: 'summary-label', textContent: 'Arbiter log' })),
    list,
  );

  return {
    root: details,
    update(match) {
      for (const event of match.events ?? []) {
        const key = `${event.at}|${event.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.append(
          el(
            'div',
            { className: `log-line ${event.level}` },
            el('time', { textContent: new Date(event.at).toLocaleTimeString() }),
            el('span', { textContent: event.message }),
          ),
        );
      }
      list.scrollTop = list.scrollHeight;
    },
  };
}

function buildGameView(matchId) {
  const openLink = el('a', { className: 'btn primary', target: '_blank', rel: 'noopener', textContent: 'Open on Lichess ↗' });
  const clocks = { white: buildClock('white'), black: buildClock('black') };
  const progress = el('div', { className: 'game-progress' });
  const deliveries = buildDeliveries();
  const log = buildLog();

  const colorSelect = el(
    'select',
    { className: 'compact' },
    el('option', { value: 'white', textContent: 'White' }),
    el('option', { value: 'black', textContent: 'Black' }),
  );
  const secondsInput = el('input', { className: 'compact', type: 'number', value: '60', min: '5', max: '10800' });
  const topUp = el('button', { className: 'btn secondary', type: 'button', textContent: 'Add time' });
  const topUpFeedback = el('div', { className: 'feedback', role: 'status', 'aria-live': 'polite' });

  topUp.addEventListener('click', async () => {
    topUp.disabled = true;
    clear(topUpFeedback);
    try {
      await api(`/api/matches/${matchId}/topup`, {
        method: 'POST',
        body: JSON.stringify({ color: colorSelect.value, seconds: Number.parseInt(secondsInput.value, 10) }),
      });
    } catch (err) {
      topUpFeedback.append(el('div', { className: 'notice bad', textContent: err.message }));
    } finally {
      topUp.disabled = false;
    }
  });

  const override = el(
    'details',
    { className: 'panel' },
    el('summary', {}, el('span', { className: 'summary-label', textContent: 'Manual override' })),
    el('p', {
      className: 'hint',
      textContent: 'Escape hatch if a scheduled bonus did not land. Delivered in 60-second calls, same as the automatic one.',
    }),
    el('div', { className: 'override-row' }, colorSelect, secondsInput, topUp),
    topUpFeedback,
  );

  const root = el(
    'div',
    { className: 'stack' },
    el(
      'section',
      { className: 'card' },
      el('div', { className: 'card-head' }, el('h2', { textContent: 'Live game' }), openLink),
      el('div', { className: 'clocks' }, clocks.white.root, clocks.black.root),
      progress,
    ),
    el(
      'section',
      { className: 'card' },
      el('div', { className: 'card-head' }, el('h2', { textContent: 'Bonus delivery' })),
      deliveries.root,
    ),
    override,
    log.root,
  );

  return {
    root,
    update(state) {
      const { match, you } = state;
      openLink.href = match.gameUrl ?? '#';
      clocks.white.update(match);
      clocks.black.update(match);
      deliveries.update(match);
      log.update(match);
      override.hidden = !(match.status === 'live' && you);

      const status = STATUS_TEXT[match.gameStatus] ?? match.gameStatus ?? 'starting';
      const winner = match.winner ? ` · ${match.winner} won` : '';
      setText(progress, `Ply ${match.plies} · ${status}${winner}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Match page — shell
// ---------------------------------------------------------------------------

const STEP_TITLES = ['You', 'Your opponent', 'Start the game'];

function buildSetupView(matchId) {
  const steps = [buildHostStep(matchId), buildOpponentStep(matchId), buildStartStep(matchId)];
  const sections = steps.map((step, index) =>
    el(
      'section',
      { className: 'card step' },
      el(
        'div',
        { className: 'step-head' },
        el('span', { className: 'step-num', 'aria-hidden': 'true', textContent: String(index + 1) }),
        el('h2', { textContent: STEP_TITLES[index] }),
      ),
      step.body,
    ),
  );

  const root = el('div', { className: 'stack' }, sections);

  return {
    root,
    update(state) {
      const { match, you, tokenCreateUrl } = state;
      steps[0].update(match);
      steps[1].update(match, tokenCreateUrl);
      steps[2].update(match, you);

      const done = [Boolean(match.seats.a), Boolean(match.seats.b), false];
      let activeMarked = false;
      sections.forEach((section, index) => {
        setClass(section, 'is-done', done[index]);
        const active = !done[index] && !activeMarked;
        if (active) activeMarked = true;
        setClass(section, 'is-active', active);
      });
    },
  };
}

function buildMatchShell(root, matchId) {
  const title = el('h1', { className: 'match-title' });
  const statusPill = el('span', { className: 'pill' });
  const meta = el('p', { className: 'match-meta' });
  const alerts = el('div', { className: 'alerts' });
  const bodySlot = el('div');

  fill(
    root,
    el(
      'div',
      { className: 'page-head' },
      el('div', { className: 'title-row' }, title, statusPill),
      meta,
    ),
    alerts,
    bodySlot,
  );

  let phase = null;
  let view = null;

  return function update(state) {
    const { match } = state;
    const nextPhase = match.gameId ? 'game' : 'setup';
    if (phase !== nextPhase) {
      phase = nextPhase;
      view = nextPhase === 'game' ? buildGameView(matchId) : buildSetupView(matchId);
      fill(bodySlot, view.root);
    }

    setText(title, match.specLabel);
    setText(statusPill, match.status.replace(/-/g, ' '));
    setClass(statusPill, 'live', match.status === 'live');
    setClass(statusPill, 'bad', Boolean(match.error));
    setText(meta, `${match.rated ? 'Rated' : 'Casual'} · ${colourSummary(match)}`);

    fill(alerts, match.error ? el('div', { className: 'notice bad', textContent: match.error }) : null, oauthAlert());

    view.update(state);
  };
}

/**
 * Read a ?error= left by the OAuth callback, then strip it from the URL so the
 * banner does not reappear on every later push.
 */
let oauthError = null;
function captureOauthError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (!error) return;
  oauthError = error;
  params.delete('error');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
}

function oauthAlert() {
  if (!oauthError) return null;
  const message =
    oauthError === 'same-account'
      ? 'You signed in with the same Lichess account that is already seated as the opponent. Time can only be added to an opponent, so the two seats must be different accounts.'
      : `Lichess sign-in failed: ${oauthError}`;
  return el('div', { className: 'notice bad', textContent: message });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function subscribe(matchId, update) {
  const source = new EventSource(`/api/matches/${matchId}/stream`);
  source.addEventListener('message', (event) => {
    try {
      update(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to render match update', err);
    }
  });
  // EventSource reconnects on its own; the next push re-syncs the whole state.
}

const root = document.getElementById('root');
const matchId = window.location.pathname.startsWith('/m/') ? window.location.pathname.slice(3) : null;

if (!matchId) {
  renderCreate(root);
} else {
  captureOauthError();
  api(`/api/matches/${matchId}`)
    .then((state) => {
      const update = buildMatchShell(root, matchId);
      update(state);
      subscribe(matchId, update);
    })
    .catch((err) => {
      fill(root, el('div', { className: 'notice bad', textContent: err.message }));
    });
}
