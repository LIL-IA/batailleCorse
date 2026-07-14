/*
 * Interface propre au jeu « Le 1% ».
 *
 * Volontairement indépendante de room.js (Bataille Corse) : chaque jeu possède
 * son interface. Version squelette — affiche l'état, permet de prendre une carte
 * au centre et de tenter sa chance aux dés. Les phases d'enchère/vote viendront.
 */
(function () {
  'use strict';

  const root = document.getElementById('up-root');
  if (!root) {
    return;
  }

  const roomCode = root.dataset.roomCode;
  const currentUserId = Number.parseInt(root.dataset.currentUserId, 10);
  const isHost = root.dataset.isHost === 'true';

  const CATEGORY_LABELS = {
    shark: 'Requin',
    lightning: 'Éclair',
    clover: 'Trèfle',
    star: 'Étoile',
    comet: 'Comète',
  };
  const CATEGORY_ICONS = {
    shark: '🦈',
    lightning: '⚡',
    clover: '🍀',
    star: '⭐',
    comet: '☄️',
  };
  const BONUS_LABELS = {
    reroll: "Relance d'un dé",
    draw2: 'Pioche 2 récompenses',
    steal: "Vol d'une carte",
  };
  const BONUS_ICONS = { reroll: '🎲', draw2: '🃏', steal: '🫳' };

  const ERROR_MESSAGES = {
    'not-ready': 'Tous les joueurs doivent être prêts.',
    'not-enough-players': 'Il faut au moins deux joueurs.',
    'start-failed': 'Erreur lors du démarrage.',
    'game-not-started': "La partie n'a pas encore commencé.",
    'game-over': 'La partie est terminée.',
    'not-host': "Seul l'hôte peut faire cela.",
    'phase-not-implemented': 'Cette phase du jeu arrive bientôt.',
    'unknown-action': 'Action inconnue.',
    'invalid-index': 'Carte indisponible.',
  };

  // --- éléments -----------------------------------------------------------
  const playersSection = document.getElementById('players-section');
  const playersList = document.getElementById('up-players-list');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const restartBtn = document.getElementById('restart-btn');
  const returnLobbyBtn = document.getElementById('return-lobby-btn');
  const board = document.getElementById('up-board');
  const waiting = document.getElementById('up-waiting');
  const centerEl = document.getElementById('up-center');
  const playersZone = document.getElementById('up-players');
  const drawCountEl = document.getElementById('up-draw-count');
  const discardCountEl = document.getElementById('up-discard-count');
  const diceEls = Array.from(document.querySelectorAll('#up-dice .up-die'));
  const rollBtn = document.getElementById('up-roll-btn');
  const rollMsg = document.getElementById('up-roll-msg');

  // --- WebSocket ----------------------------------------------------------
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws/room/${roomCode}/`);

  window.wsSend = function wsSend(obj) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  };

  const sendAction = (action, extra) => {
    window.wsSend(Object.assign({ type: 'action', action: action }, extra || {}));
  };

  socket.onopen = () => {
    if (startBtn && isHost) {
      startBtn.disabled = false;
    }
  };
  socket.onclose = () => {
    if (rollMsg) {
      rollMsg.textContent = 'Connexion perdue. Rechargez la page.';
    }
  };

  // --- rendu joueurs (salle d'attente) ------------------------------------
  function renderPlayers(players, readyIds, started, hostId) {
    if (!playersList) {
      return;
    }
    playersList.innerHTML = '';
    (players || []).forEach((p) => {
      const uid = Number.parseInt(p.userId, 10);
      const li = document.createElement('li');
      li.className = 'player-row';
      li.dataset.userId = String(uid);
      const strong = document.createElement('strong');
      strong.textContent = p.username || `Joueur ${uid}`;
      li.appendChild(strong);

      if (hostId === uid) {
        const crown = document.createElement('span');
        crown.className = 'host-indicator';
        crown.title = 'Hôte';
        crown.textContent = ' 👑';
        li.appendChild(crown);
      }

      if (!started) {
        const isReady = readyIds.has(uid);
        const status = document.createElement('span');
        status.className = `status ${isReady ? 'status-ready' : 'status-waiting'}`;
        status.textContent = isReady ? 'prêt' : 'en attente';
        li.appendChild(status);
        if (uid === currentUserId) {
          const btn = document.createElement('button');
          btn.className = 'ready-btn';
          btn.type = 'button';
          btn.textContent = isReady ? "Annuler l'état prêt" : 'Se déclarer prêt';
          btn.addEventListener('click', () =>
            window.wsSend({ type: 'ready', value: !isReady })
          );
          li.appendChild(btn);
        }
      }
      playersList.appendChild(li);
    });
  }

  // --- rendu cartes -------------------------------------------------------
  function buildCard(card, index, clickable) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'up-card';
    el.disabled = !clickable;
    if (!card || typeof card !== 'object') {
      el.classList.add('up-card--back');
      return el;
    }
    if (card.kind === 'reward') {
      el.classList.add('up-card--reward');
      el.innerHTML =
        `<span class="up-card__tag">Récompense</span>` +
        `<span class="up-card__value">${card.value}</span>` +
        `<span class="up-card__hint">débloque le ${card.value}</span>`;
    } else if (card.kind === 'bonus') {
      el.classList.add('up-card--bonus');
      const icon = BONUS_ICONS[card.power] || '🎁';
      const label = BONUS_LABELS[card.power] || card.power;
      el.innerHTML =
        `<span class="up-card__tag">Bonus</span>` +
        `<span class="up-card__icon">${icon}</span>` +
        `<span class="up-card__hint">${label}</span>`;
    } else if (card.kind === 'draw') {
      el.classList.add('up-card--draw');
      const icon = CATEGORY_ICONS[card.category] || '🎴';
      const label = CATEGORY_LABELS[card.category] || card.category;
      el.innerHTML =
        `<span class="up-card__icon">${icon}</span>` +
        `<span class="up-card__value">${card.value}</span>` +
        `<span class="up-card__hint">${label}</span>`;
    }
    if (clickable && Number.isInteger(index)) {
      el.addEventListener('click', () => sendAction('take_center', { index: index }));
      el.title = 'Prendre cette carte';
    }
    return el;
  }

  function renderCenter(center, myTurn) {
    if (!centerEl) {
      return;
    }
    centerEl.innerHTML = '';
    (center || []).forEach((card, idx) => {
      centerEl.appendChild(buildCard(card, idx, true));
    });
  }

  function renderPlayersZone(state, players) {
    if (!playersZone) {
      return;
    }
    const nameById = new Map(
      (players || []).map((p) => [Number.parseInt(p.userId, 10), p.username])
    );
    playersZone.innerHTML = '';
    (state.players || []).forEach((pid) => {
      const key = String(pid);
      const card = document.createElement('div');
      card.className = 'up-player-zone';
      if (pid === state.turn) {
        card.classList.add('is-turn');
      }
      if (pid === currentUserId) {
        card.classList.add('is-self');
      }

      const name = nameById.get(pid) || `Joueur ${pid}`;
      const nums = (state.winning_numbers && state.winning_numbers[key]) || [0];
      const prob = (state.win_probability && state.win_probability[key]) || 0;
      const rewards = (state.reward_numbers && state.reward_numbers[key]) || [];
      const bonuses = (state.bonuses && state.bonuses[key]) || [];
      const hand = (state.counts && state.counts[key]) || 0;

      const bonusText = bonuses.length
        ? bonuses.map((b) => BONUS_ICONS[b] || '🎁').join(' ')
        : '—';

      card.innerHTML =
        `<div class="up-player-zone__head">` +
        `<strong>${name}</strong>` +
        (pid === state.turn ? `<span class="up-turn-badge">à jouer</span>` : '') +
        `</div>` +
        `<div class="up-player-zone__row">Main : <b>${hand}</b> carte${hand > 1 ? 's' : ''}</div>` +
        `<div class="up-player-zone__row">Récompenses : <b>${rewards.length ? rewards.join(', ') : '—'}</b></div>` +
        `<div class="up-player-zone__row">Bonus : <b>${bonusText}</b></div>` +
        `<div class="up-player-zone__win">Numéros gagnants : <b>${nums.join(' · ')}</b>` +
        `<span class="up-prob">${prob}%</span></div>`;
      playersZone.appendChild(card);
    });
  }

  function renderRoll(lastRoll, winnerId) {
    if (!diceEls.length) {
      return;
    }
    if (lastRoll && Array.isArray(lastRoll.dice)) {
      diceEls[0].textContent = lastRoll.dice[0];
      diceEls[1].textContent = lastRoll.dice[1];
      diceEls.forEach((d) => d.classList.toggle('up-die--win', Boolean(lastRoll.win)));
      if (rollMsg && winnerId === null) {
        const mine = lastRoll.player === currentUserId ? 'Vous avez' : 'Ce joueur a';
        rollMsg.textContent = lastRoll.win
          ? `🎉 Combinaison gagnante !`
          : `${mine} lancé ${lastRoll.dice[0]} et ${lastRoll.dice[1]} — raté.`;
      }
    } else {
      diceEls.forEach((d) => {
        d.textContent = '–';
        d.classList.remove('up-die--win');
      });
    }
  }

  // --- boucle principale --------------------------------------------------
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'game_unvalidated') {
      window.location.href = '/game/lobby/' + roomCode + '/';
      return;
    }
    if (msg.error) {
      if (rollMsg) {
        rollMsg.textContent = ERROR_MESSAGES[msg.error] || msg.error;
      }
      return;
    }
    if (msg.type !== 'state' && msg.type !== 'player_joined') {
      return;
    }

    const started = Boolean(msg.started);
    const hostId = msg.hostId !== undefined ? Number.parseInt(msg.hostId, 10) : null;
    const players = Array.isArray(msg.players) ? msg.players : [];
    const readyIds = new Set(
      (Array.isArray(msg.ready) ? msg.ready : []).map((r) => Number.parseInt(r, 10))
    );
    const state = msg.state || null;
    const winnerId =
      state && state.winner !== undefined && state.winner !== null
        ? Number.parseInt(state.winner, 10)
        : null;

    // Boutons de contrôle (hôte).
    if (startBtn) {
      startBtn.style.display = isHost && !started ? '' : 'none';
    }
    if (stopBtn) {
      stopBtn.style.display = isHost && started && winnerId === null ? '' : 'none';
    }
    if (restartBtn) {
      restartBtn.style.display = isHost && winnerId !== null ? '' : 'none';
    }
    if (returnLobbyBtn) {
      returnLobbyBtn.style.display = isHost ? '' : 'none';
    }

    if (playersSection) {
      playersSection.style.display = started ? 'none' : '';
    }
    if (board) {
      board.hidden = !started;
    }
    if (waiting) {
      waiting.hidden = started;
    }

    renderPlayers(players, readyIds, started, hostId);

    if (started && state) {
      if (drawCountEl) drawCountEl.textContent = state.draw_count ?? 0;
      if (discardCountEl) discardCountEl.textContent = state.discard_count ?? 0;
      renderCenter(state.center, state.turn === currentUserId);
      renderPlayersZone(state, players);
      renderRoll(state.last_roll, winnerId);

      if (rollBtn) {
        rollBtn.disabled = winnerId !== null;
      }
      if (winnerId !== null && rollMsg) {
        const winnerName =
          (players.find((p) => Number.parseInt(p.userId, 10) === winnerId) || {}).username ||
          `Joueur ${winnerId}`;
        rollMsg.textContent =
          winnerId === currentUserId
            ? '👑 Vous rejoignez le 1% — victoire !'
            : `👑 ${winnerName} rejoint le 1% et remporte la partie !`;
      }
    }
  };

  if (rollBtn) {
    rollBtn.addEventListener('click', () => sendAction('roll'));
  }

  // Copie du code de la salle.
  const badge = document.getElementById('room-code-badge');
  if (badge && navigator.clipboard) {
    badge.addEventListener('click', () => {
      navigator.clipboard.writeText(roomCode).then(() => {
        badge.classList.add('copied');
        const hint = badge.querySelector('.room-code-badge__hint');
        if (hint) hint.textContent = 'copié !';
        setTimeout(() => {
          badge.classList.remove('copied');
          if (hint) hint.textContent = 'copier';
        }, 1600);
      });
    });
  }
})();
