(function () {
  const playActionContainer = document.getElementById('play-action-container');
  const slapBtn = document.getElementById('slap-btn');
  const playersSection = document.getElementById('players-section');

  const errorMessages = {
    'not-ready': 'Tous les joueurs doivent être prêts.',
    'not-enough-players': 'Il faut au moins deux joueurs.',
    'start-failed': 'Erreur lors du démarrage.',
    'game-not-started': "La partie n'a pas encore commencé.",
    'game-over': 'La partie est terminée.',
    'no-cards': "Vous n'avez plus de cartes.",
    'not-host': "Seul l’hôte peut modifier ces options.",
    'game-started': 'Impossible de modifier les options pendant une partie.',
    'invalid-options': 'Options invalides reçues.'
  };

  const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_NAMES = { S: 'pique', H: 'cœur', D: 'carreau', C: 'trèfle' };
  const RANK_NAMES = { A: 'As', K: 'Roi', Q: 'Dame', J: 'Valet', T: '10' };

  window.wsSend = function noop() {
    console.error('WebSocket non initialisée.');
  };

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const restartBtn = document.getElementById('restart-btn');
  const playCardBtn = document.getElementById('play-card-btn');
  const playersList = document.getElementById('players');
  if (!playersList) {
    console.error("Élément #players introuvable.");
    return;
  }

  const isHost = playersList.dataset.isHost === 'true';
  let currentGameStarted = playersList.dataset.roomStarted === 'true';

  const optionsTrigger = document.getElementById('room-options-trigger');
  const optionsModal = document.getElementById('room-options-modal');
  const optionsForm = document.getElementById('room-options-form');
  const optionsCloseBtn = document.getElementById('room-options-close');
  const optionsBackdrop = optionsModal
    ? optionsModal.querySelector('[data-room-options-close]')
    : null;
  const optionsSummary = document.getElementById('room-options-summary');

  const PENALTY_MODE_FIXED = 'fixed';
  const PENALTY_MODE_SUDDEN_DEATH = 'sudden_death';
  const PENALTY_STEPS = Object.freeze([0, 1, 2, 5]);
  const PENALTY_KEYS = new Set(['bad_slap_penalty', 'bad_play_penalty']);

  const DEFAULT_RULE_OPTIONS = Object.freeze({
    allow_double: true,
    allow_sandwich: true,
    allow_runs: false,
    allow_ten: true,
    bad_slap_penalty: 2,
    bad_play_penalty: 2,
    penalty_mode: PENALTY_MODE_FIXED
  });

  const optionsDataScript = document.getElementById('initial-room-options');

  const parseInitialOptions = () => {
    if (!optionsDataScript) {
      return null;
    }
    try {
      const parsed = JSON.parse(optionsDataScript.textContent || '');
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (err) {
      console.warn('Impossible de parser les options initiales', err);
    }
    return null;
  };

  const normalizePenaltyCount = (value, defaultValue) => {
    if (!Number.isFinite(value)) {
      return defaultValue;
    }
    if (value <= 0) {
      return 0;
    }
    const allowed = PENALTY_STEPS.filter((step) => step > 0);
    if (allowed.includes(value)) {
      return value;
    }
    for (let idx = allowed.length - 1; idx >= 0; idx -= 1) {
      const step = allowed[idx];
      if (value >= step) {
        return step;
      }
    }
    return defaultValue;
  };

  const normalizePenaltyMode = (rawValue) => {
    const normalized = String(rawValue || '')
      .trim()
      .toLowerCase()
      .replace(/[-\s]/g, '_');
    if (['sudden_death', 'suddendeath', 'mort_subite'].includes(normalized)) {
      return PENALTY_MODE_SUDDEN_DEATH;
    }
    return PENALTY_MODE_FIXED;
  };

  const coerceOptionValue = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_RULE_OPTIONS, key)) {
      return undefined;
    }
    const defaultValue = DEFAULT_RULE_OPTIONS[key];
    if (typeof defaultValue === 'boolean') {
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(lowered)) {
          return true;
        }
        if (['false', '0', 'no', 'off'].includes(lowered)) {
          return false;
        }
      }
      return Boolean(value);
    }
    if (typeof defaultValue === 'number') {
      let numeric;
      if (typeof value === 'number') {
        numeric = value;
      } else if (typeof value === 'boolean') {
        numeric = value ? 1 : 0;
      } else if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['off', 'none', 'no', 'false', 'disable', 'disabled'].includes(lowered)) {
          return 0;
        }
        numeric = Number.parseInt(lowered, 10);
      }
      if (!Number.isFinite(numeric)) {
        return defaultValue;
      }
      const sanitized = Math.max(0, Math.trunc(numeric));
      if (PENALTY_KEYS.has(key)) {
        return normalizePenaltyCount(sanitized, defaultValue);
      }
      return sanitized;
    }
    if (typeof defaultValue === 'string') {
      if (key === 'penalty_mode') {
        return normalizePenaltyMode(value);
      }
      return typeof value === 'string' ? value : defaultValue;
    }
    return defaultValue;
  };

  const sanitizeOptions = (incoming, base) => {
    const result = { ...DEFAULT_RULE_OPTIONS };
    const apply = (source) => {
      if (!source || typeof source !== 'object') {
        return;
      }
      Object.keys(result).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const coerced = coerceOptionValue(key, source[key]);
          if (coerced !== undefined) {
            result[key] = coerced;
          }
        }
      });
    };
    apply(base);
    apply(incoming);
    return result;
  };

  let roomOptionsState = sanitizeOptions(parseInitialOptions());
  let optionsModalOpen = false;
  let optionsSyncTimerId = null;
  let optionsUpdateFromServer = false;
  let lastFocusedBeforeModal = null;

  const hostOnlyNote = optionsForm
    ? optionsForm.querySelector('[data-note="host-only"]')
    : null;
  const lockedNote = optionsForm
    ? optionsForm.querySelector('[data-note="locked"]')
    : null;

  const applyOptionsToForm = (state) => {
    if (!optionsForm || !state) {
      return;
    }
    const toggles = optionsForm.querySelectorAll('[data-option-type="toggle"]');
    toggles.forEach((input) => {
      const key = input.dataset.optionKey;
      if (!key || !Object.prototype.hasOwnProperty.call(state, key)) {
        return;
      }
      input.checked = Boolean(state[key]);
    });
    const counters = optionsForm.querySelectorAll('[data-option-type="counter"]');
    counters.forEach((counter) => {
      const key = counter.dataset.optionKey;
      if (!key || !Object.prototype.hasOwnProperty.call(state, key)) {
        return;
      }
      const rawValue = state[key];
      const value = Number.isFinite(rawValue)
        ? rawValue
        : Number.parseInt(rawValue, 10) || 0;
      const display = counter.querySelector('[data-counter-value]');
      if (display) {
        display.textContent = String(value);
      }
      counter.setAttribute('aria-valuenow', String(value));
      const cardLabel = value <= 0
        ? 'Aucune carte retirée'
        : `${value} carte${value > 1 ? 's' : ''}`;
      counter.setAttribute('aria-valuetext', cardLabel);
    });
    const choices = optionsForm.querySelectorAll('[data-option-type="choice"]');
    choices.forEach((input) => {
      const key = input.dataset.optionKey;
      if (!key || !Object.prototype.hasOwnProperty.call(state, key)) {
        return;
      }
      const current = String(state[key]);
      input.checked = current === String(input.value);
    });
  };

  const formatCardCount = (value) => {
    if (!Number.isFinite(value) || value <= 0) {
      return 'aucune carte';
    }
    return `${value} carte${value > 1 ? 's' : ''}`;
  };

  const renderOptionsSummary = (state) => {
    if (!optionsSummary) {
      return;
    }
    optionsSummary.innerHTML = '';
    if (!state) {
      return;
    }
    const title = document.createElement('h4');
    title.className = 'room-options-summary__title';
    title.textContent = 'Règles en vigueur';
    optionsSummary.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'room-options-summary__list';
    optionsSummary.appendChild(list);

    const variantLabels = [];
    if (state.allow_double) variantLabels.push('Double');
    if (state.allow_sandwich) variantLabels.push('Sandwich');
    if (state.allow_runs) variantLabels.push('Suite');
    const variantsItem = document.createElement('li');
    variantsItem.textContent = `Variantes de tape : ${variantLabels.length ? variantLabels.join(', ') : 'aucune'}.`;
    list.appendChild(variantsItem);

    const tenItem = document.createElement('li');
    tenItem.textContent = state.allow_ten
      ? 'Compléments à 10 : activés.'
      : 'Compléments à 10 : désactivés.';
    list.appendChild(tenItem);

    const modeItem = document.createElement('li');
    const suddenDeath = state.penalty_mode === PENALTY_MODE_SUDDEN_DEATH;
    modeItem.textContent = suddenDeath
      ? 'Mode de pénalité : mort subite (toutes les cartes restantes sont retirées).'
      : 'Mode de pénalité : retrait d\'un nombre fixe de cartes.';
    list.appendChild(modeItem);

    const detailsItem = document.createElement('li');
    if (suddenDeath) {
      detailsItem.textContent = 'Chaque pénalité retire immédiatement tout le paquet du joueur concerné.';
    } else {
      const parts = [];
      parts.push(
        state.bad_slap_penalty <= 0
          ? 'Tape invalide : aucune carte retirée'
          : `Tape invalide : ${formatCardCount(state.bad_slap_penalty)}`
      );
      parts.push(
        state.bad_play_penalty <= 0
          ? 'Jeu hors tour : aucune carte retirée'
          : `Jeu hors tour : ${formatCardCount(state.bad_play_penalty)}`
      );
      detailsItem.textContent = `${parts.join(' · ')}.`;
    }
    list.appendChild(detailsItem);
  };

  const refreshOptionsUI = (state) => {
    applyOptionsToForm(state);
    renderOptionsSummary(state);
  };

  const updateOptionsAvailability = (started) => {
    currentGameStarted = Boolean(started);
    const interactive = isHost && !currentGameStarted;
    if (optionsForm) {
      optionsForm.classList.toggle('room-options-form--readonly', !interactive);
      const toggles = optionsForm.querySelectorAll('[data-option-type="toggle"]');
      toggles.forEach((input) => {
        input.disabled = !interactive;
        input.setAttribute('aria-disabled', interactive ? 'false' : 'true');
      });
      const counterButtons = optionsForm.querySelectorAll('[data-option-step]');
      counterButtons.forEach((btn) => {
        btn.disabled = !interactive;
        btn.setAttribute('aria-disabled', interactive ? 'false' : 'true');
      });
      const counters = optionsForm.querySelectorAll('[data-option-type="counter"]');
      counters.forEach((counter) => {
        counter.setAttribute('aria-disabled', interactive ? 'false' : 'true');
      });
      const choices = optionsForm.querySelectorAll('[data-option-type="choice"]');
      choices.forEach((input) => {
        input.disabled = !interactive;
        input.setAttribute('aria-disabled', interactive ? 'false' : 'true');
      });
    }
    if (hostOnlyNote) {
      hostOnlyNote.classList.toggle('is-hidden', isHost);
    }
    if (lockedNote) {
      lockedNote.classList.toggle('is-hidden', !currentGameStarted);
    }
    if (optionsModal) {
      optionsModal.classList.toggle('room-options-modal--readonly', !interactive);
    }
    if (optionsTrigger) {
      optionsTrigger.classList.toggle('room-options-trigger--readonly', !isHost);
      if (!isHost) {
        optionsTrigger.setAttribute(
          'title',
          'Lecture seule : seul l’hôte peut modifier ces paramètres.'
        );
      } else {
        optionsTrigger.removeAttribute('title');
      }
    }
  };

  const openOptionsModal = () => {
    if (!optionsModal || optionsModalOpen) {
      return;
    }
    optionsModalOpen = true;
    optionsModal.hidden = false;
    optionsModal.setAttribute('aria-hidden', 'false');
    optionsModal.classList.add('room-options-modal--open');
    document.body.classList.add('room-options-lock');
    lastFocusedBeforeModal = document.activeElement;
    const focusTarget = optionsForm
      ? optionsForm.querySelector('[data-option-type="toggle"]')
      : null;
    const finalTarget =
      focusTarget || optionsModal.querySelector('.room-options-modal__close');
    if (finalTarget && typeof finalTarget.focus === 'function') {
      finalTarget.focus();
    }
  };

  const closeOptionsModal = () => {
    if (!optionsModal || !optionsModalOpen) {
      return;
    }
    optionsModalOpen = false;
    optionsModal.classList.remove('room-options-modal--open');
    optionsModal.setAttribute('aria-hidden', 'true');
    optionsModal.hidden = true;
    document.body.classList.remove('room-options-lock');
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
  };

  const scheduleOptionsSync = () => {
    if (!isHost || currentGameStarted || optionsUpdateFromServer) {
      return;
    }
    if (optionsSyncTimerId !== null) {
      window.clearTimeout(optionsSyncTimerId);
    }
    const payload = { ...roomOptionsState };
    optionsSyncTimerId = window.setTimeout(() => {
      optionsSyncTimerId = null;
      if (typeof window.wsSend === 'function') {
        window.wsSend({ type: 'update_rules', options: payload });
      }
    }, 150);
  };

  const updateOptionValue = (key, rawValue) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_RULE_OPTIONS, key)) {
      return;
    }
    const sanitized = sanitizeOptions({ [key]: rawValue }, roomOptionsState);
    const changed = Object.keys(DEFAULT_RULE_OPTIONS).some(
      (optionKey) => sanitized[optionKey] !== roomOptionsState[optionKey]
    );
    roomOptionsState = sanitized;
    refreshOptionsUI(roomOptionsState);
    if (changed && !optionsUpdateFromServer) {
      scheduleOptionsSync();
    }
  };

  const handleOptionsFromServer = (rawOptions) => {
    const sanitized = sanitizeOptions(rawOptions);
    const changed = Object.keys(DEFAULT_RULE_OPTIONS).some(
      (key) => roomOptionsState[key] !== sanitized[key]
    );
    roomOptionsState = sanitized;
    optionsUpdateFromServer = true;
    refreshOptionsUI(roomOptionsState);
    optionsUpdateFromServer = false;
    return changed;
  };

  if (optionsForm) {
    optionsForm.addEventListener('submit', (event) => event.preventDefault());
    optionsForm.addEventListener('change', (event) => {
      const target = event.target;
      if (!target || !target.dataset.optionType) {
        return;
      }
      const key = target.dataset.optionKey;
      if (!key) {
        return;
      }
      if (target.dataset.optionType === 'toggle') {
        updateOptionValue(key, target.checked);
      } else if (target.dataset.optionType === 'choice') {
        updateOptionValue(key, target.value);
      }
    });
    optionsForm.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.dataset.optionStep) {
        return;
      }
      event.preventDefault();
      const container = target.closest('[data-option-type="counter"]');
      if (!container) {
        return;
      }
      const key = container.dataset.optionKey;
      if (!key) {
        return;
      }
      const direction = target.dataset.optionStep === 'up' ? 1 : -1;
      const currentValueRaw = roomOptionsState[key];
      const currentValue = Number.isFinite(currentValueRaw)
        ? currentValueRaw
        : Number.parseInt(currentValueRaw, 10) || 0;
      let nextValue = currentValue + direction;
      if (PENALTY_KEYS.has(key)) {
        const currentIndex = PENALTY_STEPS.indexOf(currentValue);
        const fallbackIndex = PENALTY_STEPS.indexOf(DEFAULT_RULE_OPTIONS[key]);
        const baseIndex = currentIndex === -1
          ? (fallbackIndex === -1 ? 0 : fallbackIndex)
          : currentIndex;
        const targetIndex = Math.min(
          PENALTY_STEPS.length - 1,
          Math.max(0, baseIndex + direction)
        );
        nextValue = PENALTY_STEPS[targetIndex];
      }
      updateOptionValue(key, nextValue);
    });
  }

  if (optionsTrigger && optionsModal) {
    optionsTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      openOptionsModal();
    });
  }

  if (optionsCloseBtn) {
    optionsCloseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      closeOptionsModal();
    });
  }

  if (optionsBackdrop) {
    optionsBackdrop.addEventListener('click', (event) => {
      event.preventDefault();
      closeOptionsModal();
    });
  }

  refreshOptionsUI(roomOptionsState);
  updateOptionsAvailability(currentGameStarted);

  const tableSelector = playersList.dataset.tableSelector || '#table';
  const centerPileSelector = playersList.dataset.centerPileSelector || '#center-pile';
  const penaltyPileSelector = playersList.dataset.penaltyPileSelector || '#penalty-pile';
  const playerDeckSelector = playersList.dataset.playerDeckSelector || '.player-deck';
  let centerPileInteractiveEl = null;
  let playerDecksContainer = null;

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

  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${wsScheme}://${location.host}/ws/room/${roomCode}/`);

  let playCardShouldBeDisabled = false;
  let temporaryActionsDisabled = false;
  let temporaryDisableTimerId = null;

  const applyPlayCardDisabledState = () => {
    if (!playCardBtn) {
      return;
    }
    const shouldDisable = temporaryActionsDisabled || playCardShouldBeDisabled;
    const ariaValue = shouldDisable ? 'true' : 'false';
    playCardBtn.disabled = shouldDisable;
    playCardBtn.setAttribute('aria-disabled', ariaValue);
  };

  const setActionButtonsDisabled = (disabled) => {
    const effectiveDisabled = disabled || temporaryActionsDisabled;
    document.querySelectorAll('.action-btn').forEach((btn) => {
      if (effectiveDisabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        return;
      }
      if (btn === playCardBtn) {
        applyPlayCardDisabledState();
      } else {
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'false');
      }
    });
    updateCenterPileActionMarker();
  };

  const disableActionButtonsTemporarily = (durationMs = 1000) => {
    temporaryActionsDisabled = true;
    setActionButtonsDisabled(true);
    if (temporaryDisableTimerId !== null) {
      window.clearTimeout(temporaryDisableTimerId);
    }
    temporaryDisableTimerId = window.setTimeout(() => {
      temporaryActionsDisabled = false;
      temporaryDisableTimerId = null;
      setActionButtonsDisabled(false);
    }, durationMs);
  };

  const isElementEffectivelyVisible = (element) => {
    if (!element) {
      return false;
    }
    if (element.hidden) {
      return false;
    }
    if (typeof element.getClientRects === 'function' && element.getClientRects().length > 0) {
      return true;
    }
    const style = window.getComputedStyle(element);
    return !(
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    );
  };

  const isSlapActionCurrentlyEnabled = () => {
    if (!currentGameStarted || temporaryActionsDisabled) {
      return false;
    }
    if (!slapBtn || slapBtn.disabled) {
      return false;
    }
    if (!isElementEffectivelyVisible(slapBtn)) {
      return false;
    }
    return true;
  };

  let centerPileActionAvailableFromState = false;

  function updateCenterPileActionMarker(element) {
    const target =
      element ||
      centerPileInteractiveEl ||
      document.querySelector(centerPileSelector);
    if (!target) {
      return;
    }
    const isAvailable = centerPileActionAvailableFromState && isSlapActionCurrentlyEnabled();
    target.classList.toggle('center-pile-clickable', isAvailable);
    if (isAvailable) {
      target.setAttribute('tabindex', '0');
      target.setAttribute('aria-disabled', 'false');
    } else {
      target.removeAttribute('tabindex');
      target.setAttribute('aria-disabled', 'true');
    }
  }

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
      const winnerTsRaw = winner && winner.t_ns !== undefined ? winner.t_ns : null;
      const winnerTs =
        typeof winnerTsRaw === 'number' ? winnerTsRaw : Number.parseInt(winnerTsRaw, 10);
      const winnerName =
        (winnerId !== null && playersById.get(winnerId)) ||
        (winnerId !== null ? `Joueur ${winnerId}` : 'Gagnant');
      const winnerLine = document.createElement('p');
      winnerLine.className = 'slap-overlay-winner';
      winnerLine.textContent = 'Gagnant : ';
      const winnerStrong = document.createElement('strong');
      winnerStrong.textContent = winnerName;
      winnerLine.appendChild(winnerStrong);
      if (Number.isFinite(winnerTs)) {
        const winnerTimeSpan = document.createElement('span');
        winnerTimeSpan.textContent = ` (${(0).toFixed(2)} ms)`;
        winnerLine.appendChild(winnerTimeSpan);
      }
      content.appendChild(winnerLine);

      const candidates = Array.isArray(action && action.candidates) ? action.candidates : [];
      if (candidates.length) {
        const label = document.createElement('p');
        label.className = 'slap-overlay-candidates-title';
        label.textContent = candidates.length > 1 ? 'Candidats :' : 'Candidat :';
        content.appendChild(label);

        const list = document.createElement('ol');
        list.className = 'slap-overlay-candidates';
        const baseTs = Number.isFinite(winnerTs)
          ? winnerTs
          : (() => {
              const first = candidates[0] && candidates[0].t_ns;
              const parsed = typeof first === 'number' ? first : Number.parseInt(first, 10);
              return Number.isFinite(parsed) ? parsed : null;
            })();
        candidates.forEach((candidate) => {
          const li = document.createElement('li');
          const cid = candidate ? parseId(candidate.userId) : null;
          const candidateName =
            (cid !== null && playersById.get(cid)) ||
            (cid !== null ? `Joueur ${cid}` : 'Inconnu');
          const tsRaw = candidate && candidate.t_ns !== undefined ? candidate.t_ns : null;
          const ts = typeof tsRaw === 'number' ? tsRaw : Number.parseInt(tsRaw, 10);
          let text = candidateName;
          if (Number.isFinite(ts) && Number.isFinite(baseTs)) {
            const deltaMs = (ts - baseTs) / 1e6;
            text += ` - ${deltaMs.toFixed(2)} ms`;
          }
          li.textContent = text;
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

  const gameWinnerOverlay = (() => {
    let overlayEl = null;

    const ensureOverlay = () => {
      const tableEl = document.querySelector(tableSelector);
      if (!tableEl) {
        return null;
      }
      if (!overlayEl || overlayEl.parentElement !== tableEl) {
        overlayEl = document.createElement('div');
        overlayEl.className = 'slap-overlay game-winner-overlay';
        overlayEl.setAttribute('role', 'alert');
        overlayEl.setAttribute('aria-live', 'assertive');
        overlayEl.setAttribute('aria-hidden', 'true');
        tableEl.appendChild(overlayEl);
      }
      return overlayEl;
    };

    const hide = () => {
      if (!overlayEl) {
        return;
      }
      overlayEl.classList.remove('slap-overlay-visible', 'slap-overlay-animate');
      overlayEl.setAttribute('aria-hidden', 'true');
      overlayEl.innerHTML = '';
    };

    const show = (winnerName) => {
      const overlay = ensureOverlay();
      if (!overlay) {
        return;
      }
      overlay.innerHTML = '';
      overlay.classList.remove('slap-overlay-animate');
      overlay.classList.add('slap-overlay-visible');
      overlay.setAttribute('aria-hidden', 'false');

      const content = document.createElement('div');
      content.className = 'slap-overlay-content';

      const title = document.createElement('h3');
      title.textContent = 'Partie terminée';
      content.appendChild(title);

      const message = document.createElement('p');
      message.className = 'slap-overlay-winner';
      message.textContent = 'Victoire de ';
      const strong = document.createElement('strong');
      strong.textContent = winnerName;
      message.appendChild(strong);
      message.appendChild(document.createTextNode(' !'));
      content.appendChild(message);

      overlay.appendChild(content);
    };

    return {
      show,
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
    const listHidden =
      (playersSection && playersSection.style.display === 'none') ||
      (playersList && playersList.style.display === 'none');

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
      li.classList.toggle(
        'current-turn',
        !listHidden && currentTurnId !== null && userId === currentTurnId
      );

      const rawUsername = typeof player.username === 'string' ? player.username : '';
      const username = rawUsername || `Joueur ${userId}`;

      if (started) {
        li.innerHTML = `<strong>${username}</strong>`;
        li.classList.remove('player-ready', 'player-waiting');
      } else {
        const isReady = readySet.has(userId);
        const statusText = isReady ? 'prêt' : 'en attente';
        const statusClass = isReady ? 'status-ready' : 'status-waiting';
        const shouldDisable = currentUserId === null || userId !== currentUserId;
        const readyButtonHtml = createReadyButtonHtml(shouldDisable, isReady);
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
      if (msg.error === 'no-cards' || msg.error === 'game-over') {
        playCardShouldBeDisabled = true;
        applyPlayCardDisabledState();
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
      updateOptionsAvailability(started);
      playersList.dataset.roomStarted = started ? 'true' : 'false';
      const hasWinner = msg.winner !== undefined && msg.winner !== null;
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
      if (stopBtn) {
        const showStop =
          currentUserId !== null && msg.hostId === currentUserId && msg.started && !hasWinner;
        stopBtn.style.display = showStop ? '' : 'none';
      }
      if (restartBtn) {
        const showRestart =
          currentUserId !== null && msg.hostId === currentUserId && hasWinner;
        restartBtn.style.display = showRestart ? '' : 'none';
      }
      if (playersSection) {
        playersSection.style.display = started ? 'none' : '';
      }
      if (playersList) {
        playersList.style.display = started ? 'none' : '';
      }
      if (playActionContainer) playActionContainer.style.display = started ? '' : 'none';
      if (slapBtn) slapBtn.style.display = started ? '' : 'none';
      const state = msg.state || null;
      const optionsPayload =
        (state && typeof state === 'object' ? state.options : null) ||
        (msg.options && typeof msg.options === 'object' ? msg.options : null);
      if (optionsPayload) {
        handleOptionsFromServer(optionsPayload);
      }
      const currentTurnId = state ? parseId(state.turn) : null;
      setCurrentTurnDataset(currentTurnId);

      const playersById = new Map(
        players
          .map((player) => [parseId(player.userId), player.username])
          .filter(([id]) => id !== null)
      );

      const nextCountsMap = computeCountsMap(state);

      renderTable(state, players, msg.lastAction, playersById);

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

  centerPileInteractiveEl = document.querySelector(centerPileSelector);
  let lastCenterPilePointerDownTs = 0;
  let lastPlayerDeckPointerDownTs = 0;

  const canTriggerSlapFromCenterPile = () => {
    if (!centerPileInteractiveEl) {
      return false;
    }
    if (!centerPileInteractiveEl.classList.contains('center-pile-clickable')) {
      return false;
    }
    return isSlapActionCurrentlyEnabled();
  };

  updateCenterPileActionMarker(centerPileInteractiveEl);

  const handleCenterPileActivation = (event) => {
    if (event.type === 'pointerdown') {
      if (event.isPrimary === false) {
        return;
      }
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      lastCenterPilePointerDownTs = Date.now();
    } else if (event.type === 'click') {
      if (
        lastCenterPilePointerDownTs !== 0 &&
        Date.now() - lastCenterPilePointerDownTs < 350
      ) {
        lastCenterPilePointerDownTs = 0;
        return;
      }
    }

    if (!canTriggerSlapFromCenterPile()) {
      return;
    }

    wsSend({ type: 'slap' });
    event.preventDefault();

    if (event.type === 'click') {
      lastCenterPilePointerDownTs = 0;
    }
  };

  if (centerPileInteractiveEl) {
    centerPileInteractiveEl.addEventListener('pointerdown', handleCenterPileActivation);
    centerPileInteractiveEl.addEventListener('click', handleCenterPileActivation);
  }

  const canTriggerPlayFromDeck = () => {
    if (currentUserId === null) {
      return false;
    }
    if (temporaryActionsDisabled) {
      return false;
    }
    const playDisabled = playCardBtn
      ? Boolean(playCardBtn.disabled)
      : Boolean(playCardShouldBeDisabled);
    if (playDisabled) {
      return false;
    }
    return true;
  };

  const handlePlayerDeckActivation = (event) => {
    if (!(event.currentTarget instanceof Element)) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }

    const container = event.currentTarget;
    const deck = event.target.closest(playerDeckSelector);
    if (!deck || !container.contains(deck)) {
      return;
    }

    const currentUserKey = currentUserId !== null ? String(currentUserId) : null;
    if (!currentUserKey || deck.dataset.userId !== currentUserKey) {
      return;
    }

    if (event.type === 'pointerdown') {
      if (event.isPrimary === false) {
        return;
      }
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      lastPlayerDeckPointerDownTs = Date.now();
    } else if (event.type === 'click') {
      if (
        lastPlayerDeckPointerDownTs !== 0 &&
        Date.now() - lastPlayerDeckPointerDownTs < 350
      ) {
        lastPlayerDeckPointerDownTs = 0;
        return;
      }
    }

    if (!canTriggerPlayFromDeck()) {
      return;
    }

    wsSend({ type: 'play' });
    event.preventDefault();

    if (event.type === 'click') {
      lastPlayerDeckPointerDownTs = 0;
    }
  };

  const bindPlayerDecksContainer = (container) => {
    if (!container || !(container instanceof Element)) {
      return;
    }
    if (playerDecksContainer === container) {
      return;
    }
    if (playerDecksContainer) {
      playerDecksContainer.removeEventListener('pointerdown', handlePlayerDeckActivation);
      playerDecksContainer.removeEventListener('click', handlePlayerDeckActivation);
    }
    playerDecksContainer = container;
    playerDecksContainer.addEventListener('pointerdown', handlePlayerDeckActivation);
    playerDecksContainer.addEventListener('click', handlePlayerDeckActivation);
  };

  bindPlayerDecksContainer(document.getElementById('player-decks'));

  document.addEventListener('keydown', (event) => {
    if (optionsModalOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOptionsModal();
      }
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      wsSend({ type: 'slap' });
    } else if (event.code === 'Enter') {
      event.preventDefault();
      wsSend({ type: 'play' });
    }
  });

  function createReadyButtonHtml(disabled, isReady) {
    const nextValue = isReady ? 'false' : 'true';
    const label = isReady ? "Annuler l'état prêt" : 'Se déclarer prêt';
    const disabledAttributes = disabled ? ' disabled aria-disabled="true"' : '';
    const ariaPressed = isReady ? 'true' : 'false';
    return `<button class="ready-btn" type="button"${disabledAttributes} aria-pressed="${ariaPressed}" onclick="wsSend({type:'ready', value:${nextValue}})">${label}</button>`;
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

  function renderTable(state, players, lastAction, playersById) {
    const tableEl = document.querySelector(tableSelector);
    const centerPileEl = document.querySelector(centerPileSelector);
    const penaltyPileEl = document.querySelector(penaltyPileSelector);
    if (!tableEl || !centerPileEl) {
      centerPileActionAvailableFromState = false;
      updateCenterPileActionMarker();
      return;
    }

    tableEl.classList.add('table');
    handleLastActionFeedback(tableEl, lastAction);

    const currentTurnId = parseId(playersList.dataset.currentTurnId);
    const currentTurnKey = currentTurnId !== null ? String(currentTurnId) : '';
    const currentUserKey = currentUserId !== null ? String(currentUserId) : null;
    const resolvedPlayersById =
      playersById instanceof Map
        ? playersById
        : new Map(
            (Array.isArray(players) ? players : [])
              .map((player) => [parseId(player.userId), player.username])
              .filter(([id]) => id !== null)
          );

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

    bindPlayerDecksContainer(decksContainer);

    const counts = (state && state.counts) || {};
    let currentUserCount = null;
    if (state && currentUserKey && Object.prototype.hasOwnProperty.call(counts, currentUserKey)) {
      const rawCurrentCount = counts[currentUserKey];
      const parsedCurrentCount =
        typeof rawCurrentCount === 'number'
          ? rawCurrentCount
          : Number.parseInt(rawCurrentCount, 10);
      if (Number.isFinite(parsedCurrentCount)) {
        currentUserCount = parsedCurrentCount;
      }
    }
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

        const deckContent = document.createElement('div');
        deckContent.className = 'deck-content';
        deck.appendChild(deckContent);

        const deckCard = document.createElement('div');
        deckCard.className = 'deck-card';
        const cardBack = document.createElement('div');
        cardBack.className = 'card-back';
        deckCard.appendChild(cardBack);
        deckContent.appendChild(deckCard);

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

        deckContent.appendChild(info);

        deck.style.removeProperty('transform');
        deck.style.removeProperty('left');
        deck.style.removeProperty('top');
        deck.style.removeProperty('--deck-angle');
        deck.style.removeProperty('--deck-content-angle');
        deck.style.removeProperty('z-index');
        deck.classList.remove(
          'player-deck-top',
          'player-deck-bottom',
          'player-deck-left',
          'player-deck-right',
          'player-deck-solo'
        );
        deck.classList.toggle('current-turn', currentTurnKey !== '' && key === currentTurnKey);

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
      deck.style.setProperty('--deck-content-angle', '0deg');
      deck.classList.add('player-deck-solo', 'player-deck-bottom');
      deck.classList.remove('player-deck-top', 'player-deck-left', 'player-deck-right');
      deck.style.zIndex = '9';
    } else if (totalDecks >= 2) {
      const radiusPercent = totalDecks === 2 ? 36 : 44;
      deckElements.forEach((deck, idx) => {
        const angle = (idx / totalDecks) * Math.PI * 2 - Math.PI / 2;
        const x = 50 + radiusPercent * Math.cos(angle);
        const y = 50 + radiusPercent * Math.sin(angle);
        const angleDeg = (angle * 180) / Math.PI;
        deck.style.left = `${x}%`;
        deck.style.top = `${y}%`;
        deck.style.setProperty('--deck-angle', `${angleDeg}deg`);
        deck.style.setProperty('--deck-content-angle', `${-angleDeg}deg`);
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

    const justCollected = Boolean(lastAction && lastAction.collected);
    const pendingCollect = !justCollected && Boolean(state && state.pending_collect);
    const collectWinnerId =
      pendingCollect && state ? parseId(state.collect_winner) : null;
    const isCollectWinner =
      pendingCollect &&
      collectWinnerId !== null &&
      currentUserId !== null &&
      collectWinnerId === currentUserId;
    const hasWinner = Boolean(state && state.winner !== undefined && state.winner !== null);
    const winnerId = hasWinner ? parseId(state.winner) : null;

    if (playCardBtn) {
      playCardBtn.classList.toggle('collect-highlight', isCollectWinner);
      playCardBtn.textContent = isCollectWinner
        ? 'Récupérer les cartes'
        : 'Jouer une carte';
    }

    if (hasWinner) {
      const resolvedName = winnerId !== null ? resolvedPlayersById.get(winnerId) : null;
      const fallbackName = winnerId !== null ? `Joueur ${winnerId}` : 'Gagnant';
      const winnerName =
        typeof resolvedName === 'string' && resolvedName && resolvedName.trim()
          ? resolvedName
          : fallbackName;
      gameWinnerOverlay.show(winnerName);
      slapOverlayManager.hide();
    } else {
      gameWinnerOverlay.hide();
    }

    let shouldDisablePlayButton = false;
    if (hasWinner) {
      shouldDisablePlayButton = true;
    } else if (state && currentUserCount === 0) {
      shouldDisablePlayButton = !isCollectWinner;
    }

    playCardShouldBeDisabled = shouldDisablePlayButton;
    applyPlayCardDisabledState();

    const effectivePlayDisabled = playCardBtn
      ? Boolean(playCardBtn.disabled)
      : Boolean(temporaryActionsDisabled || playCardShouldBeDisabled);
    deckElements.forEach((deck) => {
      deck.classList.remove('player-deck-self-clickable');
      deck.removeAttribute('tabindex');
      deck.removeAttribute('aria-disabled');
      if (currentUserKey && deck.dataset.userId === currentUserKey) {
        if (!effectivePlayDisabled) {
          deck.classList.add('player-deck-self-clickable');
          deck.setAttribute('tabindex', '0');
          deck.setAttribute('aria-disabled', 'false');
        } else {
          deck.setAttribute('aria-disabled', 'true');
        }
      }
    });

    centerPileEl.classList.toggle('pending-collect', pendingCollect);
    centerPileEl.innerHTML = '';

    if (penaltyPileEl) {
      let rawPenaltyCount = state ? state.penalty_count : 0;
      let penaltyCount =
        typeof rawPenaltyCount === 'number'
          ? rawPenaltyCount
          : Number.parseInt(rawPenaltyCount, 10);
      if (!Number.isFinite(penaltyCount) || penaltyCount < 0) {
        penaltyCount = 0;
      }
      penaltyPileEl.innerHTML = '';
      penaltyPileEl.classList.toggle('penalty-empty', penaltyCount === 0);
      if (penaltyCount > 0) {
        const back = document.createElement('div');
        back.className = 'card-back';
        penaltyPileEl.appendChild(back);
        const countEl = document.createElement('span');
        countEl.className = 'penalty-count';
        countEl.textContent = String(penaltyCount);
        penaltyPileEl.appendChild(countEl);
      }
    }

    const lastFour = state && Array.isArray(state.last_four_center)
      ? state.last_four_center.slice(-4)
      : [];

    let rawCenterCount = state ? state.center_count : 0;
    let centerCount =
      typeof rawCenterCount === 'number'
        ? rawCenterCount
        : Number.parseInt(rawCenterCount, 10);
    if (!Number.isFinite(centerCount)) {
      centerCount = lastFour.length;
    }
    if (centerCount < 0) {
      centerCount = 0;
    }

    const hasCenterPileCards = !justCollected && centerCount > 0;
    const stateAllowsSlap =
      Boolean(state) && !hasWinner && !pendingCollect && hasCenterPileCards;
    centerPileActionAvailableFromState = stateAllowsSlap;
    updateCenterPileActionMarker(centerPileEl);

    const topCard =
      state && typeof state.top_center === 'string' ? state.top_center : null;

    let cardsToRender = [];
    if (!justCollected && centerCount > 0) {
      if (lastFour.length) {
        cardsToRender = lastFour;
      } else if (topCard) {
        cardsToRender = [topCard];
      }
    }

    const hasCards = cardsToRender.length > 0;

    if (!state) {
      centerPileEl.classList.add('center-empty');
      const p = document.createElement('p');
      p.textContent = 'En attente du début de la partie…';
      centerPileEl.appendChild(p);
    } else if (!hasCards && pendingCollect) {
      centerPileEl.classList.remove('center-empty');
      const p = document.createElement('p');
      p.textContent = 'Tas en attente de ramassage.';
      centerPileEl.appendChild(p);
    } else if (!hasCards) {
      centerPileEl.classList.add('center-empty');
      const p = document.createElement('p');
      p.textContent = 'Tas central vide.';
      centerPileEl.appendChild(p);
    } else {
      centerPileEl.classList.remove('center-empty');
      const stack = document.createElement('div');
      stack.className = 'center-pile';

      const totalCount = centerCount || cardsToRender.length;
      const startIndex = Math.max(totalCount - cardsToRender.length, 0);

      cardsToRender.forEach((card, idx) => {
        const pileCard = document.createElement('div');
        pileCard.className = 'card-visual center-card';

        const rotation = ((startIndex + idx) * 45) % 360;
        pileCard.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
        pileCard.style.zIndex = String(10 + idx);

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
