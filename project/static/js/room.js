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

  const tableSelector = playersList.dataset.tableSelector || '#table';
  const centerPileSelector = playersList.dataset.centerPileSelector || '#center-pile';
  const playerDeckSelector = playersList.dataset.playerDeckSelector || '.player-deck';

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
  let previousCountsMap = new Map();
  let lastHandledActionKey = '';
  let lastHandledActionTimestamp = 0;
  let lastStartedState = null;

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

  const SLAP_FEEDBACK_CLASSES = ['slap-success', 'slap-fail'];
  const SLAP_OVERLAY_DURATION_MS = 1600;

  const clearSlapFeedback = (tableEl) => {
    if (!tableEl) {
      return;
    }
    SLAP_FEEDBACK_CLASSES.forEach((cls) => tableEl.classList.remove(cls));
  };

  const playSlapFeedback = (tableEl, kind) => {
    if (!tableEl) {
      return;
    }
    if (!kind) {
      clearSlapFeedback(tableEl);
      return;
    }
    const className = kind === 'success' ? 'slap-success' : kind === 'fail' ? 'slap-fail' : null;
    if (!className) {
      clearSlapFeedback(tableEl);
      return;
    }
    clearSlapFeedback(tableEl);
    void tableEl.offsetWidth;
    tableEl.classList.add(className);
    const cleanup = () => {
      clearSlapFeedback(tableEl);
      tableEl.removeEventListener('animationend', cleanup);
    };
    tableEl.addEventListener('animationend', cleanup, { once: true });
  };

  const handleLastActionFeedback = (tableEl, lastAction) => {
    if (!tableEl) {
      return;
    }
    const actionType = lastAction && typeof lastAction.type === 'string' ? lastAction.type : '';
    const previous = tableEl.dataset.lastActionType || '';
    if (actionType === previous) {
      return;
    }
    tableEl.dataset.lastActionType = actionType;
    if (actionType === 'slap_resolved') {
      playSlapFeedback(tableEl, 'success');
    } else if (actionType === 'slap_invalid' || actionType === 'slap_none') {
      playSlapFeedback(tableEl, 'fail');
    } else {
      playSlapFeedback(tableEl, null);
    }
  };

  const slapOverlayManager = (() => {
    let overlayEl = null;
    let fallbackTimerId = null;
    let currentAnimationHandler = null;

    const ensureOverlay = () => {
      const tableEl = document.querySelector(tableSelector);
      if (!tableEl) {
        return null;
      }
      if (!overlayEl || overlayEl.parentElement !== tableEl) {
        overlayEl = document.createElement('div');
        overlayEl.className = 'slap-overlay';
        overlayEl.setAttribute('role', 'alert');
        overlayEl.setAttribute('aria-live', 'assertive');
        overlayEl.setAttribute('aria-hidden', 'true');
        tableEl.appendChild(overlayEl);
      }
      return overlayEl;
    };

    const clearTimer = () => {
      if (fallbackTimerId !== null) {
        window.clearTimeout(fallbackTimerId);
        fallbackTimerId = null;
      }
    };

    const hide = () => {
      clearTimer();
      if (!overlayEl) {
        return;
      }
      if (currentAnimationHandler) {
        overlayEl.removeEventListener('animationend', currentAnimationHandler);
        currentAnimationHandler = null;
      }
      overlayEl.classList.remove('slap-overlay-visible', 'slap-overlay-animate');
      overlayEl.setAttribute('aria-hidden', 'true');
      overlayEl.innerHTML = '';
    };

    const scheduleFallback = () => {
      clearTimer();
      fallbackTimerId = window.setTimeout(() => {
        if (overlayEl && currentAnimationHandler) {
          overlayEl.removeEventListener('animationend', currentAnimationHandler);
          currentAnimationHandler = null;
        }
        hide();
      }, SLAP_OVERLAY_DURATION_MS + 200);
    };

    const showResolution = (action, playersById) => {
      const overlay = ensureOverlay();
      if (!overlay) {
        return;
      }
      if (currentAnimationHandler) {
        overlay.removeEventListener('animationend', currentAnimationHandler);
        currentAnimationHandler = null;
      }
      overlay.innerHTML = '';
      overlay.setAttribute('aria-hidden', 'false');
      overlay.classList.add('slap-overlay-visible');

      const content = document.createElement('div');
      content.className = 'slap-overlay-content';

      const title = document.createElement('h3');
      title.textContent = 'Taper réussi !';
      content.appendChild(title);

      const winner = action && action.winner ? action.winner : null;
      const winnerId = winner ? parseId(winner.userId) : null;
      const winnerName =
        (winnerId !== null && playersById.get(winnerId)) ||
        (winnerId !== null ? `Joueur ${winnerId}` : 'Gagnant');
      const winnerLine = document.createElement('p');
      winnerLine.className = 'slap-overlay-winner';
      winnerLine.textContent = 'Gagnant : ';
      const winnerStrong = document.createElement('strong');
      winnerStrong.textContent = winnerName;
      winnerLine.appendChild(winnerStrong);
      content.appendChild(winnerLine);

      const candidates = Array.isArray(action && action.candidates) ? action.candidates : [];
      if (candidates.length) {
        const label = document.createElement('p');
        label.className = 'slap-overlay-candidates-title';
        label.textContent = candidates.length > 1 ? 'Candidats :' : 'Candidat :';
        content.appendChild(label);

        const list = document.createElement('ol');
        list.className = 'slap-overlay-candidates';
        candidates.forEach((candidate) => {
          const li = document.createElement('li');
          const cid = candidate ? parseId(candidate.userId) : null;
          const candidateName =
            (cid !== null && playersById.get(cid)) ||
            (cid !== null ? `Joueur ${cid}` : 'Inconnu');
          li.textContent = candidateName;
          if (cid !== null && winnerId !== null && cid === winnerId) {
            li.classList.add('is-winner');
          }
          list.appendChild(li);
        });
        content.appendChild(list);
      }

      overlay.appendChild(content);
      overlay.classList.remove('slap-overlay-animate');
      void overlay.offsetWidth;
      overlay.classList.add('slap-overlay-animate');

      const onAnimationEnd = (event) => {
        if (event.target !== overlay) {
          return;
        }
        currentAnimationHandler = null;
        hide();
      };
      currentAnimationHandler = onAnimationEnd;
      overlay.addEventListener('animationend', onAnimationEnd);
      scheduleFallback();
    };

    return {
      showResolution,
      hide
    };
  })();

  const triggerInvalidSlapAnimation = (userId) => {
    const parsedId = parseId(userId);
    if (parsedId === null) {
      return;
    }
    const tableEl = document.querySelector(tableSelector);
    if (!tableEl) {
      return;
    }
    const deck = tableEl.querySelector(`${playerDeckSelector}[data-user-id="${String(parsedId)}"]`);
    if (!deck) {
      return;
    }
    deck.classList.remove('slap-deck-error');
    void deck.offsetWidth;
    deck.classList.add('slap-deck-error');
    const fallbackId = window.setTimeout(() => {
      deck.classList.remove('slap-deck-error');
    }, 700);
    const cleanup = () => {
      window.clearTimeout(fallbackId);
      deck.classList.remove('slap-deck-error');
    };
    deck.addEventListener('animationend', cleanup, { once: true });
  };

  const inferPenalizedPlayerId = (previousCounts, nextCounts, lastAction) => {
    if (!lastAction || !lastAction.res) {
      return null;
    }
    const penalizedRaw = lastAction.res.penalized;
    const penalized = typeof penalizedRaw === 'number' ? penalizedRaw : Number.parseInt(penalizedRaw, 10);
    if (!Number.isFinite(penalized)) {
      return null;
    }
    const matches = [];
    previousCounts.forEach((prevCount, userId) => {
      const nextCount = nextCounts.has(userId) ? nextCounts.get(userId) : 0;
      const diff = prevCount - nextCount;
      if (penalized > 0) {
        if (diff === penalized) {
          matches.push(userId);
        }
      } else if (penalized === 0 && diff !== 0) {
        matches.push(userId);
      }
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const computeCountsMap = (state) => {
    const map = new Map();
    if (!state || !state.counts || typeof state.counts !== 'object') {
      return map;
    }
    Object.entries(state.counts).forEach(([key, value]) => {
      const userId = parseId(key);
      if (userId === null) {
        return;
      }
      const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10);
      map.set(userId, Number.isFinite(numeric) ? numeric : 0);
    });
    return map;
  };

  const computeLastActionKey = (lastAction) => {
    if (!lastAction || typeof lastAction.type !== 'string') {
      return '';
    }
    const type = lastAction.type;
    if (type === 'slap_resolved') {
      const winnerId = parseId(lastAction.winner && lastAction.winner.userId);
      const winnerTs =
        lastAction.winner && lastAction.winner.t_ns !== undefined ? lastAction.winner.t_ns : '';
      const candidates = Array.isArray(lastAction.candidates)
        ? lastAction.candidates.map((candidate) => {
            const cid = candidate ? parseId(candidate.userId) : null;
            return cid !== null ? cid : '';
          })
        : [];
      return `${type}:${winnerId !== null ? winnerId : ''}:${winnerTs}:${candidates.join(',')}`;
    }
    if (type === 'slap_invalid') {
      const actorId = parseId(lastAction.userId);
      let penalized = null;
      if (lastAction.res && lastAction.res.penalized !== undefined) {
        const raw = lastAction.res.penalized;
        penalized = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
        if (!Number.isFinite(penalized)) {
          penalized = null;
        }
      }
      return `${type}:${actorId !== null ? actorId : ''}:${penalized !== null ? penalized : ''}`;
    }
    return type;
  };

  const handleStateLastAction = (lastAction, playersById, previousCounts, nextCounts) => {
    const actionKey = computeLastActionKey(lastAction);
    const now = Date.now();
    if (actionKey === lastHandledActionKey && now - lastHandledActionTimestamp < 500) {
      return;
    }
    lastHandledActionKey = actionKey;
    lastHandledActionTimestamp = now;

    if (!lastAction || typeof lastAction.type !== 'string') {
      slapOverlayManager.hide();
      return;
    }

    if (lastAction.type === 'slap_resolved') {
      slapOverlayManager.showResolution(lastAction, playersById);
      return;
    }

    slapOverlayManager.hide();

    if (lastAction.type === 'slap_invalid') {
      const explicit = parseId(lastAction.userId);
      let targetId = explicit;
      if (targetId === null) {
        targetId = inferPenalizedPlayerId(previousCounts, nextCounts, lastAction);
      }
      if (targetId !== null) {
        triggerInvalidSlapAnimation(targetId);
      }
    }
  };

  socket.onopen = () => console.log('WS ouvert');

  function renderPlayersList(players, readyIds, started, currentTurnId) {
    if (!playersList) {
      return;
    }
    const readySet = readyIds instanceof Set ? readyIds : new Set();
    const fragment = document.createDocumentFragment();
    const seen = new Set();

    (Array.isArray(players) ? players : []).forEach((player) => {
      if (!player) {
        return;
      }
      const userId = parseId(player.userId);
      if (userId === null || seen.has(userId)) {
        return;
      }
      seen.add(userId);

      const li = document.createElement('li');
      li.dataset.userId = String(userId);
      li.classList.add('player-row');
      li.classList.toggle('current-turn', currentTurnId !== null && userId === currentTurnId);

      const rawUsername = typeof player.username === 'string' ? player.username : '';
      const username = rawUsername || `Joueur ${userId}`;

      if (started) {
        li.innerHTML = `<strong>${username}</strong>`;
        li.classList.remove('player-ready', 'player-waiting');
      } else {
        const isReady = readySet.has(userId);
        const statusText = isReady ? 'prêt' : 'en attente';
        const statusClass = isReady ? 'status-ready' : 'status-waiting';
        const shouldDisable =
          currentUserId === null || userId !== currentUserId || isReady;
        const readyButtonHtml = createReadyButtonHtml(shouldDisable);
        li.innerHTML = `<strong>${username}</strong> <span class="status ${statusClass}">${statusText}</span> ${readyButtonHtml}`;
        li.classList.toggle('player-ready', isReady);
        li.classList.toggle('player-waiting', !isReady);
      }

      fragment.appendChild(li);
    });

    playersList.innerHTML = '';
    playersList.appendChild(fragment);
  }
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (Object.prototype.hasOwnProperty.call(msg, 'playerLeft')) {
      const leftId = parseId(msg.playerLeft);
      let leftName = '';
      if (leftId !== null) {
        const leftPlayer = playersList.querySelector(
          `li[data-user-id="${leftId}"] strong`
        );
        if (leftPlayer && leftPlayer.textContent) {
          leftName = leftPlayer.textContent;
        }
      }
      const leaveMessage = leftName
        ? `${leftName} a quitté la partie.`
        : 'Un joueur a quitté la partie.';
      if (errorDiv) {
        errorDiv.textContent = leaveMessage;
      }
      if (typeof window.alert === 'function') {
        window.alert(leaveMessage);
      }
    }
    if (msg.error) {
      const err = errorMessages[msg.error] || msg.error;
      window.alert(err);
      if (errorDiv) {
        errorDiv.textContent = err;
      }
      disableActionButtonsTemporarily();
      return;
    }

    if (msg.type === 'player_joined' && !Array.isArray(msg.players)) {
      return;
    }

    if (msg.type === 'state' || msg.type === 'player_joined') {
      setActionButtonsDisabled(false);
      const started = Boolean(msg.started);
      const readyIds = new Set(
        (Array.isArray(msg.ready) ? msg.ready : [])
          .map(parseId)
          .filter((id) => id !== null)
      );
      if (lastStartedState === true && !started) {
        readyIds.clear();
      }
      const players = Array.isArray(msg.players) ? msg.players : [];
      if (startBtn) {
        const shouldShow =
          currentUserId !== null && msg.hostId === currentUserId && !msg.started;
        startBtn.style.display = shouldShow ? '' : 'none';
      }
      const state = msg.state || null;
      const currentTurnId = state ? parseId(state.turn) : null;
      setCurrentTurnDataset(currentTurnId);

      const playersById = new Map(
        players
          .map((player) => [parseId(player.userId), player.username])
          .filter(([id]) => id !== null)
      );

      const nextCountsMap = computeCountsMap(state);

      updateTopCard(state, started);
      updateCenterCount(state, started);
      updatePlayerCounts(state, players, started);
      renderTable(state, players, msg.lastAction);

      handleStateLastAction(msg.lastAction, playersById, previousCountsMap, nextCountsMap);
      previousCountsMap = nextCountsMap;

      renderPlayersList(players, readyIds, started, currentTurnId);
      lastStartedState = started;
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

  function formatSuitSymbol(card) {
    if (!card) {
      return '';
    }
    const suit = card[1];
    return SUIT_SYMBOLS[suit] || '';
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
    const topLeft = document.createElement('span');
    topLeft.className = 'card-corner top-left';
    topLeft.textContent = formatCardSymbol(card);
    visual.appendChild(topLeft);

    const symbol = document.createElement('span');
    symbol.className = 'card-symbol';
    symbol.textContent = formatSuitSymbol(card);
    visual.appendChild(symbol);

    const bottomRight = document.createElement('span');
    bottomRight.className = 'card-corner bottom-right';
    bottomRight.textContent = formatCardSymbol(card);
    visual.appendChild(bottomRight);
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

  function renderTable(state, players, lastAction) {
    const tableEl = document.querySelector(tableSelector);
    const centerPileEl = document.querySelector(centerPileSelector);
    if (!tableEl || !centerPileEl) {
      return;
    }

    tableEl.classList.add('table');
    handleLastActionFeedback(tableEl, lastAction);

    let decksContainer = tableEl.querySelector('#player-decks');
    if (!decksContainer) {
      const existingDeck = tableEl.querySelector(playerDeckSelector);
      if (existingDeck && existingDeck.parentElement) {
        decksContainer = existingDeck.parentElement;
      }
    }
    if (!decksContainer) {
      decksContainer = document.createElement('div');
      decksContainer.id = 'player-decks';
      tableEl.appendChild(decksContainer);
    }

    const counts = (state && state.counts) || {};
    const activeIds = new Set();
    const deckElements = [];

    if (!Array.isArray(players) || players.length === 0) {
      decksContainer.innerHTML = '';
    } else {
      players.forEach((player, index) => {
        const userId = parseId(player.userId);
        if (userId === null) {
          return;
        }
        const key = String(userId);
        activeIds.add(key);

        let deck = decksContainer.querySelector(`${playerDeckSelector}[data-user-id="${key}"]`);
        if (!deck) {
          deck = document.createElement('div');
          deck.classList.add('player-deck');
          deck.dataset.userId = key;
          decksContainer.appendChild(deck);
        }

        deck.dataset.username = player.username || '';
        deck.classList.add('player-deck');
        deck.innerHTML = '';

        const deckCard = document.createElement('div');
        deckCard.className = 'deck-card';
        const cardBack = document.createElement('div');
        cardBack.className = 'card-back';
        deckCard.appendChild(cardBack);
        deck.appendChild(deckCard);

        const info = document.createElement('div');
        info.className = 'deck-info';

        const title = document.createElement('h3');
        title.textContent = player.username || `Joueur ${index + 1}`;
        info.appendChild(title);

        const countEl = document.createElement('p');
        countEl.className = 'deck-count';
        if (!state) {
          countEl.textContent = 'En attente…';
        } else {
          const rawCount = counts[key];
          const count = typeof rawCount === 'number' ? rawCount : Number.parseInt(rawCount, 10);
          const safeCount = Number.isFinite(count) ? count : 0;
          countEl.textContent = `${safeCount} carte${safeCount > 1 ? 's' : ''}`;
        }
        info.appendChild(countEl);

        deck.appendChild(info);

        deck.style.removeProperty('transform');
        deck.style.removeProperty('left');
        deck.style.removeProperty('top');
        deck.style.removeProperty('--deck-angle');
        deck.style.removeProperty('z-index');
        deck.classList.remove(
          'player-deck-top',
          'player-deck-bottom',
          'player-deck-left',
          'player-deck-right',
          'player-deck-solo'
        );

        deckElements.push(deck);
      });

      decksContainer.querySelectorAll(playerDeckSelector).forEach((deck) => {
        const uid = deck.dataset.userId;
        if (!activeIds.has(uid)) {
          deck.remove();
        }
      });
    }

    const totalDecks = deckElements.length;
    decksContainer.dataset.playerCount = String(totalDecks);

    if (totalDecks === 1) {
      const deck = deckElements[0];
      deck.style.left = '50%';
      deck.style.top = '78%';
      deck.style.setProperty('--deck-angle', '0deg');
      deck.classList.add('player-deck-solo', 'player-deck-bottom');
      deck.classList.remove('player-deck-top', 'player-deck-left', 'player-deck-right');
      deck.style.zIndex = '9';
    } else if (totalDecks >= 2) {
      const radiusPercent = totalDecks === 2 ? 32 : 38;
      deckElements.forEach((deck, idx) => {
        const angle = (idx / totalDecks) * Math.PI * 2 - Math.PI / 2;
        const x = 50 + radiusPercent * Math.cos(angle);
        const y = 50 + radiusPercent * Math.sin(angle);
        const angleDeg = (angle * 180) / Math.PI;
        deck.style.left = `${x}%`;
        deck.style.top = `${y}%`;
        deck.style.setProperty('--deck-angle', `${angleDeg}deg`);
        const isTop = y <= 50;
        const isBottom = !isTop;
        const isLeft = x < 50 - 0.5;
        const isRight = x > 50 + 0.5;
        deck.classList.toggle('player-deck-top', isTop);
        deck.classList.toggle('player-deck-bottom', isBottom);
        deck.classList.toggle('player-deck-left', isLeft);
        deck.classList.toggle('player-deck-right', isRight);
        deck.classList.remove('player-deck-solo');
        deck.style.zIndex = isTop ? '6' : '9';
      });
    }

    centerPileEl.innerHTML = '';

    const lastThree = state && Array.isArray(state.last_three_center)
      ? state.last_three_center.slice(-3)
      : [];

    if (!state) {
      centerPileEl.classList.add('center-empty');
      const p = document.createElement('p');
      p.textContent = 'En attente du début de la partie…';
      centerPileEl.appendChild(p);
    } else if (!lastThree.length) {
      centerPileEl.classList.add('center-empty');
      const p = document.createElement('p');
      p.textContent = 'Tas central vide.';
      centerPileEl.appendChild(p);
    } else {
      centerPileEl.classList.remove('center-empty');
      const stack = document.createElement('div');
      stack.className = 'center-pile';

      const positions = ['bottom', 'mid', 'top'];
      const offset = Math.max(positions.length - lastThree.length, 0);

      lastThree.forEach((card, idx) => {
        const pileCard = document.createElement('div');
        pileCard.className = 'card-visual center-card';
        const positionClass = positions[offset + idx] || 'top';
        pileCard.classList.add(positionClass);

        if (card && (card[1] === 'H' || card[1] === 'D')) {
          pileCard.classList.add('red');
        }

        const topLeft = document.createElement('span');
        topLeft.className = 'card-corner top-left';
        topLeft.textContent = formatCardSymbol(card);
        pileCard.appendChild(topLeft);

        const symbol = document.createElement('span');
        symbol.className = 'card-symbol';
        symbol.textContent = formatSuitSymbol(card);
        pileCard.appendChild(symbol);

        const bottomRight = document.createElement('span');
        bottomRight.className = 'card-corner bottom-right';
        bottomRight.textContent = formatCardSymbol(card);
        pileCard.appendChild(bottomRight);

        const readable = formatCardName(card);
        if (readable) {
          pileCard.setAttribute('aria-label', readable);
          pileCard.title = readable;
        }

        stack.appendChild(pileCard);
      });

      centerPileEl.appendChild(stack);
    }
  }
})();
