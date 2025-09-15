(function () {
  const errorMessages = {
    'not-ready': 'Tous les joueurs doivent être prêts.',
    'not-enough-players': 'Il faut au moins deux joueurs.',
    'start-failed': 'Erreur lors du démarrage.'
  };

  const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAMES = { S: 'pique', H: 'cœur', D: 'carreau', C: 'trèfle' };
  const RANK_NAMES = { A: 'As', K: 'Roi', Q: 'Dame', J: 'Valet', T: '10' };

  window.wsSend = function noop() {
    console.error('WebSocket non initialisée.');
  };

  const startBtn = document.getElementById('start-btn');
  const playersList = document.getElementById('players');
  if (!playersList) {
    console.error("Élément #players introuvable.");
    return;
  }

  const parseId = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const roomCode = playersList.dataset.roomCode;
  if (!roomCode) {
    console.error('Code de salle introuvable.');
    return;
  }

  const currentUserId = parseId(playersList.dataset.currentUserId);

  const setCurrentTurnDataset = (turnId) => {
    playersList.dataset.currentTurnId = turnId !== null && turnId !== undefined ? String(turnId) : '';
  };
  setCurrentTurnDataset(parseId(playersList.dataset.currentTurnId));

  const errorDiv = document.getElementById('error-message');
  const topCardContent = document.querySelector('#top-card .state-content');
  const centerCountContent = document.querySelector('#center-count .state-content');
  const playerCountsContent = document.querySelector('#player-counts .state-content');

  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${wsScheme}://${location.host}/ws/room/${roomCode}/`);

  const setActionButtonsDisabled = (disabled) => {
    document.querySelectorAll('.action-btn').forEach((btn) => {
      btn.disabled = disabled;
    });
  };

  const disableActionButtonsTemporarily = (durationMs = 1000) => {
    setActionButtonsDisabled(true);
    window.setTimeout(() => setActionButtonsDisabled(false), durationMs);
  };

  socket.onopen = () => console.log('WS ouvert');

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.error) {
      const err = errorMessages[msg.error] || msg.error;
      window.alert(err);
      if (errorDiv) {
        errorDiv.textContent = err;
      }
      disableActionButtonsTemporarily();
      return;
    }

    if (msg.type === 'state') {
      setActionButtonsDisabled(false);
      const readyIds = new Set(
        (Array.isArray(msg.ready) ? msg.ready : [])
          .map(parseId)
          .filter((id) => id !== null)
      );
      const players = Array.isArray(msg.players) ? msg.players : [];
      const started = Boolean(msg.started);
      if (startBtn) {
        startBtn.style.display = started ? 'none' : '';
      }
      const state = msg.state || null;
      const currentTurnId = state ? parseId(state.turn) : null;
      setCurrentTurnDataset(currentTurnId);

      updateTopCard(state, started);
      updateCenterCount(state, started);
      updatePlayerCounts(state, players, started);

      const playersById = new Map(
        players
          .map((player) => [parseId(player.userId), player.username])
          .filter(([id]) => id !== null)
      );

      const present = new Set(
        Array.from(playersList.querySelectorAll('li'))
          .map((li) => parseId(li.dataset.userId))
          .filter((id) => id !== null)
      );

      players.forEach((player) => {
        const userId = parseId(player.userId);
        if (userId === null || present.has(userId)) {
          return;
        }
        const li = document.createElement('li');
        li.dataset.userId = String(userId);
        li.classList.add('player-row');
        playersList.appendChild(li);
        present.add(userId);
      });

      playersList.querySelectorAll('li').forEach((li) => {
        const uid = parseId(li.dataset.userId);
        const strong = li.querySelector('strong');
        const fallbackName = strong ? strong.textContent : '';
        const username = (uid !== null && playersById.get(uid)) || fallbackName;
        li.classList.add('player-row');

        const isReady = uid !== null && readyIds.has(uid);
        const statusText = isReady ? 'prêt' : 'en attente';
        const statusClass = isReady ? 'status-ready' : 'status-waiting';
        const shouldDisable =
          currentUserId === null || uid === null || uid !== currentUserId || isReady;

        if (started) {
          li.innerHTML = `<strong>${username}</strong>`;
        } else {
          const readyButtonHtml = createReadyButtonHtml(shouldDisable);
          li.innerHTML = `<strong>${username}</strong> <span class="status ${statusClass}">${statusText}</span> ${readyButtonHtml}`;
        }

        const isCurrentTurn = currentTurnId !== null && uid !== null && uid === currentTurnId;
        li.classList.toggle('current-turn', isCurrentTurn);

        if (started) {
          li.classList.remove('player-ready', 'player-waiting');
        } else {
          li.classList.toggle('player-ready', isReady);
          li.classList.toggle('player-waiting', !isReady);
        }
      });
    }
  };

  socket.onerror = (err) => {
    console.error('WS erreur', err);
  };

  socket.onclose = (event) => {
    console.log('WS fermé', event.code, event.reason);
    const msg = document.createElement('div');
    msg.innerHTML = '<p>Connexion perdue.</p><button id="rejoin-btn">Rejoindre à nouveau</button>';
    document.body.appendChild(msg);
    const rejoinBtn = document.getElementById('rejoin-btn');
    if (rejoinBtn) {
      rejoinBtn.onclick = () => window.location.reload();
    }
  };

  function wsSend(obj) {
    if (socket.readyState !== WebSocket.OPEN) {
      console.error('Socket fermée, tentative de reconnexion');
      return;
    }
    socket.send(JSON.stringify(obj));
  }

  window.wsSend = wsSend;

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      wsSend({ type: 'slap' });
    }
  });

  function createReadyButtonHtml(disabled) {
    return `<button class="ready-btn" type="button" onclick="wsSend({type:'ready', value:true})"${disabled ? ' disabled' : ''}>Se déclarer prêt</button>`;
  }

  function formatCardSymbol(card) {
    if (!card) {
      return '';
    }
    const rank = card[0];
    const suit = card[1];
    const displayRank = rank === 'T' ? '10' : rank;
    const symbol = SUIT_SYMBOLS[suit] || '';
    return `${displayRank}${symbol}`;
  }

  function formatCardName(card) {
    if (!card) {
      return '';
    }
    const rank = card[0];
    const suit = card[1];
    const rankName = RANK_NAMES[rank] || rank;
    const suitName = SUIT_NAMES[suit];
    return suitName ? `${rankName} de ${suitName}` : rankName;
  }

  function updateTopCard(state, started) {
    if (!topCardContent) {
      return;
    }
    topCardContent.innerHTML = '';
    if (!state || !state.top_center) {
      const message = started ? 'Tas central vide.' : 'En attente du début de la partie.';
      const p = document.createElement('p');
      p.textContent = message;
      topCardContent.appendChild(p);
      return;
    }
    const card = state.top_center;
    const visual = document.createElement('div');
    visual.className = 'card-visual';
    const suit = card[1];
    if (suit === 'H' || suit === 'D') {
      visual.classList.add('red');
    }
    const symbol = document.createElement('span');
    symbol.className = 'card-symbol';
    symbol.textContent = formatCardSymbol(card);
    visual.appendChild(symbol);
    visual.setAttribute('aria-label', formatCardName(card));
    topCardContent.appendChild(visual);

    const label = document.createElement('p');
    label.className = 'card-name';
    label.textContent = formatCardName(card);
    topCardContent.appendChild(label);
  }

  function updateCenterCount(state, started) {
    if (!centerCountContent) {
      return;
    }
    centerCountContent.innerHTML = '';
    if (!state) {
      const p = document.createElement('p');
      p.textContent = started ? 'Tas central vide.' : 'En attente du début de la partie.';
      centerCountContent.appendChild(p);
      return;
    }
    const count = typeof state.center_count === 'number' ? state.center_count : 0;
    const p = document.createElement('p');
    if (count === 0) {
      p.textContent = 'Tas central vide.';
    } else {
      p.textContent = `${count} carte${count > 1 ? 's' : ''} dans le tas central.`;
    }
    centerCountContent.appendChild(p);
  }

  function updatePlayerCounts(state, players, started) {
    if (!playerCountsContent) {
      return;
    }
    playerCountsContent.innerHTML = '';
    if (!state || !state.counts) {
      const p = document.createElement('p');
      p.textContent = started ? 'Cartes non disponibles.' : 'En attente du début de la partie.';
      playerCountsContent.appendChild(p);
      return;
    }
    const counts = state.counts || {};
    if (!players.length) {
      const p = document.createElement('p');
      p.textContent = 'Aucun joueur trouvé.';
      playerCountsContent.appendChild(p);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'player-counts-list';
    players.forEach((player) => {
      const li = document.createElement('li');
      const count = counts[String(player.userId)] ?? 0;
      li.textContent = `${player.username} : ${count} carte${count > 1 ? 's' : ''}`;
      list.appendChild(li);
    });
    playerCountsContent.appendChild(list);
  }
})();
