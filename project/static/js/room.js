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

  const DECK_MODE_AUTO = 'auto';
  const DECK_MODE_MANUAL = 'manual';
  const PENALTY_STEPS = Object.freeze([0, 1, 2, 3, 4, 5]);
  const PENALTY_KEYS = new Set(['bad_slap_penalty', 'bad_play_penalty']);
  const PENALTY_SUDDEN_DEATH_MAP = Object.freeze({
    bad_slap_penalty: 'bad_slap_sudden_death',
    bad_play_penalty: 'bad_play_sudden_death'
  });
  const PENALTY_SUDDEN_DEATH_KEYS = new Set(
    Object.values(PENALTY_SUDDEN_DEATH_MAP)
  );

  const DEFAULT_RULE_OPTIONS = Object.freeze({
    allow_double: true,
    allow_sandwich: true,
    allow_runs: false,
    allow_ten_card: true,
    allow_ten_sum: true,
    allow_ten_sandwich: true,
    bad_slap_penalty: 2,
    bad_play_penalty: 2,
    bad_slap_sudden_death: false,
    bad_play_sudden_death: false,
    deck_mode: DECK_MODE_AUTO,
    deck_count: 1
  });

  const TEN_OPTION_KEYS = Object.freeze([
    'allow_ten_card',
    'allow_ten_sum',
    'allow_ten_sandwich'
  ]);

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
    const fallback = Number.isFinite(defaultValue)
      ? Math.max(
          PENALTY_STEPS[0],
          Math.min(
            PENALTY_STEPS[PENALTY_STEPS.length - 1],
            Math.trunc(defaultValue)
          )
        )
      : DEFAULT_RULE_OPTIONS.bad_slap_penalty;
    if (!Number.isFinite(value)) {
      return fallback;
    }
    const numeric = Math.max(
      PENALTY_STEPS[0],
      Math.min(
        PENALTY_STEPS[PENALTY_STEPS.length - 1],
        Math.trunc(value)
      )
    );
    if (PENALTY_STEPS.includes(numeric)) {
      return numeric;
    }
    let closest = PENALTY_STEPS[0];
    let minDiff = Math.abs(numeric - closest);
    for (let idx = 1; idx < PENALTY_STEPS.length; idx += 1) {
      const step = PENALTY_STEPS[idx];
      const diff = Math.abs(numeric - step);
      if (diff < minDiff) {
        closest = step;
        minDiff = diff;
      }
    }
    return closest;
  };

  const normalizeLegacyPenaltyMode = (rawValue) => {
    if (rawValue === null || rawValue === undefined) {
      return null;
    }
    const normalized = String(rawValue)
      .trim()
      .toLowerCase()
      .replace(/[-\s]/g, '_');
    if (!normalized) {
      return null;
    }
    if (['sudden_death', 'suddendeath', 'mort_subite'].includes(normalized)) {
      return 'sudden_death';
    }
    if (['fixed', 'fixe', 'standard', 'retrait_fixe'].includes(normalized)) {
      return 'fixed';
    }
    return 'fixed';
  };

  const normalizeDeckMode = (rawValue) => {
    if (typeof rawValue === 'string') {
      const lowered = rawValue.trim().toLowerCase().replace(/[-\s]/g, '_');
      if (['manuel', 'manuelle', 'manual'].includes(lowered)) {
        return DECK_MODE_MANUAL;
      }
      if (['auto', 'automatic', 'automatique', 'auto_mode'].includes(lowered)) {
        return DECK_MODE_AUTO;
      }
    } else if (typeof rawValue === 'boolean') {
      return rawValue ? DECK_MODE_MANUAL : DECK_MODE_AUTO;
    } else if (rawValue !== null && rawValue !== undefined) {
      const lowered = String(rawValue).trim().toLowerCase().replace(/[-\s]/g, '_');
      if (['manuel', 'manuelle', 'manual'].includes(lowered)) {
        return DECK_MODE_MANUAL;
      }
      if (['auto', 'automatic', 'automatique', 'auto_mode'].includes(lowered)) {
        return DECK_MODE_AUTO;
      }
    }
    return DEFAULT_RULE_OPTIONS.deck_mode;
  };

  const normalizeDeckCount = (value, defaultValue = DEFAULT_RULE_OPTIONS.deck_count) => {
    const fallback = Number.isFinite(defaultValue)
      ? Math.min(3, Math.max(1, Math.trunc(defaultValue)))
      : DEFAULT_RULE_OPTIONS.deck_count;
    let numeric;
    if (typeof value === 'number') {
      numeric = value;
    } else if (typeof value === 'boolean') {
      numeric = value ? 1 : 0;
    } else if (typeof value === 'string') {
      numeric = Number.parseInt(value, 10);
    } else if (value !== null && value !== undefined) {
      numeric = Number.parseInt(String(value), 10);
    }
    if (!Number.isFinite(numeric)) {
      numeric = fallback;
    }
    numeric = Math.trunc(numeric);
    if (!Number.isFinite(numeric)) {
      numeric = fallback;
    }
    if (numeric < 1) {
      return 1;
    }
    if (numeric > 3) {
      return 3;
    }
    return numeric;
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
      if (key === 'deck_count') {
        return normalizeDeckCount(sanitized, defaultValue);
      }
      if (PENALTY_KEYS.has(key)) {
        return normalizePenaltyCount(sanitized, defaultValue);
      }
      return sanitized;
    }
    if (typeof defaultValue === 'string') {
      if (key === 'deck_mode') {
        return normalizeDeckMode(value);
      }
      return typeof value === 'string' ? value : defaultValue;
    }
    return defaultValue;
  };

  const sanitizeOptions = (incoming, base) => {
    const result = { ...DEFAULT_RULE_OPTIONS };
    const togglesFromIncoming = new Set();
    let legacyPenaltyMode = null;
    const apply = (source, trackIncoming) => {
      if (!source || typeof source !== 'object') {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(source, 'penalty_mode')) {
        const normalizedLegacy = normalizeLegacyPenaltyMode(source.penalty_mode);
        if (normalizedLegacy) {
          legacyPenaltyMode = normalizedLegacy;
        }
      }
      const provided = new Set();
      Object.keys(result).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const coerced = coerceOptionValue(key, source[key]);
          if (coerced !== undefined) {
            result[key] = coerced;
            if (trackIncoming && PENALTY_SUDDEN_DEATH_KEYS.has(key)) {
              togglesFromIncoming.add(key);
            }
            provided.add(key);
          }
        }
      });
      if (Object.prototype.hasOwnProperty.call(source, 'allow_ten')) {
        const aliasValue = coerceOptionValue('allow_ten_card', source.allow_ten);
        TEN_OPTION_KEYS.forEach((tenKey) => {
          if (!provided.has(tenKey) && aliasValue !== undefined) {
            result[tenKey] = aliasValue;
          }
        });
      }
    };
    apply(base, false);
    apply(incoming, true);
    if (legacyPenaltyMode) {
      const isSuddenDeath = legacyPenaltyMode === 'sudden_death';
      Object.values(PENALTY_SUDDEN_DEATH_MAP).forEach((toggleKey) => {
        if (!toggleKey || togglesFromIncoming.has(toggleKey)) {
          return;
        }
        result[toggleKey] = isSuddenDeath;
      });
    }
    result.deck_mode = normalizeDeckMode(result.deck_mode);
    result.deck_count = normalizeDeckCount(result.deck_count);
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
  const deckCountContainer = optionsForm
    ? optionsForm.querySelector('[data-deck-count-container]')
    : null;
  const deckCountInputs = deckCountContainer
    ? Array.from(deckCountContainer.querySelectorAll('input[data-option-key="deck_count"]'))
    : [];
  const optionsSummaryElement = document.querySelector('[data-options-summary]');
  const defaultOptionsSummaryText =
    optionsSummaryElement && optionsSummaryElement.textContent
      ? optionsSummaryElement.textContent.trim()
      : '';

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

  const renderOptionsSummary = () => {
    if (!optionsSummaryElement) {
      return;
    }
    const shouldDisplay = !currentGameStarted;
    if (shouldDisplay) {
      const baseText =
        defaultOptionsSummaryText || 'Ajustez les règles avant de lancer la partie.';
      optionsSummaryElement.textContent = baseText;
      optionsSummaryElement.hidden = false;
      optionsSummaryElement.removeAttribute('hidden');
      optionsSummaryElement.setAttribute('aria-hidden', 'false');
      return;
    }
    optionsSummaryElement.textContent = '';
    optionsSummaryElement.hidden = true;
    optionsSummaryElement.setAttribute('hidden', '');
    optionsSummaryElement.setAttribute('aria-hidden', 'true');
  };

  const syncPenaltyCounterStates = (state, interactiveOverride) => {
    if (!optionsForm) {
      return;
    }
    const minPenaltyStep =
      PENALTY_STEPS.length > 0 ? PENALTY_STEPS[0] : 0;
    const maxPenaltyStep =
      PENALTY_STEPS.length > 0
        ? PENALTY_STEPS[PENALTY_STEPS.length - 1]
        : minPenaltyStep;
    const interactive =
      interactiveOverride !== undefined
        ? interactiveOverride
        : isHost && !currentGameStarted;
    const safeState =
      state && typeof state === 'object' ? state : DEFAULT_RULE_OPTIONS;
    const counters = optionsForm.querySelectorAll('[data-option-type="counter"]');
    counters.forEach((counter) => {
      const key = counter.dataset.optionKey;
      if (!key || !Object.prototype.hasOwnProperty.call(safeState, key)) {
        return;
      }
      const suddenKey =
        counter.dataset.suddenDeathKey || PENALTY_SUDDEN_DEATH_MAP[key];
      const suddenEnabled =
        suddenKey && Object.prototype.hasOwnProperty.call(safeState, suddenKey)
          ? Boolean(safeState[suddenKey])
          : false;
      const shouldDisable = !interactive || suddenEnabled;
      const ariaDisabledValue = shouldDisable ? 'true' : 'false';
      counter.setAttribute('aria-valuemin', String(minPenaltyStep));
      counter.setAttribute('aria-valuemax', String(maxPenaltyStep));
      counter.setAttribute('aria-disabled', ariaDisabledValue);
      counter.setAttribute('aria-readonly', shouldDisable ? 'true' : 'false');
      counter.classList.toggle('room-options-counter--sudden-death', suddenEnabled);
      if (suddenKey) {
        counter.setAttribute('data-sudden-death', suddenEnabled ? 'true' : 'false');
      } else {
        counter.removeAttribute('data-sudden-death');
      }
      const buttons = counter.querySelectorAll('[data-option-step]');
      buttons.forEach((btn) => {
        btn.disabled = shouldDisable;
        btn.setAttribute('aria-disabled', ariaDisabledValue);
      });
      const rawValue = safeState[key];
      const value = Number.isFinite(rawValue)
        ? rawValue
        : Number.parseInt(rawValue, 10) || 0;
      const valueLabel = suddenEnabled
        ? 'Mort subite activée'
        : value <= 0
          ? 'Aucune carte retirée'
          : `${value} carte${value > 1 ? 's' : ''}`;
      counter.setAttribute('aria-valuetext', valueLabel);
    });
  };

  const syncDeckControls = (state, interactiveOverride) => {
    if (!deckCountContainer || deckCountInputs.length === 0) {
      return;
    }
    const interactive =
      interactiveOverride !== undefined ? interactiveOverride : isHost && !currentGameStarted;
    const manualMode = normalizeDeckMode(state && state.deck_mode) === DECK_MODE_MANUAL;
    if (manualMode) {
      deckCountContainer.removeAttribute('hidden');
      deckCountContainer.setAttribute('aria-hidden', 'false');
    } else {
      deckCountContainer.setAttribute('hidden', '');
      deckCountContainer.setAttribute('aria-hidden', 'true');
    }
    const shouldDisable = !interactive || !manualMode;
    deckCountContainer.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
    deckCountInputs.forEach((input) => {
      input.disabled = shouldDisable;
      input.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
    });
  };

  const refreshOptionsUI = (state) => {
    applyOptionsToForm(state);
    syncDeckControls(state);
    syncPenaltyCounterStates(state);
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
      const choices = optionsForm.querySelectorAll('[data-option-type="choice"]');
      choices.forEach((input) => {
        input.disabled = !interactive;
        input.setAttribute('aria-disabled', interactive ? 'false' : 'true');
      });
      syncDeckControls(roomOptionsState, interactive);
      syncPenaltyCounterStates(roomOptionsState, interactive);
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
    renderOptionsSummary();
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
      const suddenKey =
        container.dataset.suddenDeathKey || PENALTY_SUDDEN_DEATH_MAP[key];
      if (
        suddenKey &&
        Object.prototype.hasOwnProperty.call(roomOptionsState, suddenKey) &&
        roomOptionsState[suddenKey]
      ) {
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

  const playSound = (name) => {
    if (window.GameSounds && typeof window.GameSounds.play === 'function') {
      window.GameSounds.play(name);
    }
  };

  const toFiniteCount = (raw) => {
    const numeric = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    return Number.isFinite(numeric) ? numeric : 0;
  };

  const avatarHue = (userId) => {
    const id = Number.isFinite(userId) ? userId : 0;
    // Angle d'or : répartit les teintes uniformément quel que soit l'id.
    return Math.round((id * 137.508) % 360);
  };

  const createAvatarEl = (userId, username) => {
    const el = document.createElement('span');
    el.className = 'player-avatar';
    el.style.setProperty('--avatar-hue', String(avatarHue(userId)));
    const initial = (username || '').trim().charAt(0).toUpperCase();
    el.textContent = initial || '?';
    el.setAttribute('aria-hidden', 'true');
    return el;
  };

  const prefersReducedMotion = () =>
    Boolean(
      window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );

  let lastTurnToastTs = 0;
  const showTurnToast = () => {
    const tableEl = document.querySelector(tableSelector);
    if (!tableEl) {
      return;
    }
    const now = Date.now();
    // Anti-spam : dans les parties à deux, le tour revient très souvent.
    if (now - lastTurnToastTs < 4000) {
      return;
    }
    lastTurnToastTs = now;
    const existing = tableEl.querySelector('.turn-toast');
    if (existing) {
      existing.remove();
    }
    const toast = document.createElement('div');
    toast.className = 'turn-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = 'À vous de jouer !';
    tableEl.appendChild(toast);
    const removeToast = () => toast.remove();
    toast.addEventListener('animationend', removeToast, { once: true });
    window.setTimeout(removeToast, 2400);
  };

  const CONFETTI_COLORS = [
    '#f59e0b',
    '#ef4444',
    '#3b82f6',
    '#10b981',
    '#eab308',
    '#a855f7',
    '#f8fafc'
  ];
  let confettiActive = false;
  const launchConfetti = () => {
    const tableEl = document.querySelector(tableSelector);
    if (!tableEl || confettiActive || prefersReducedMotion()) {
      return;
    }
    confettiActive = true;
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 90; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--delay', `${Math.random() * 1.6}s`);
      piece.style.setProperty('--fall', `${2.4 + Math.random() * 1.8}s`);
      piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      piece.style.setProperty('--size', `${6 + Math.random() * 7}px`);
      piece.style.backgroundColor = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      layer.appendChild(piece);
    }
    tableEl.appendChild(layer);
    window.setTimeout(() => {
      layer.remove();
      confettiActive = false;
    }, 6500);
  };

  const animateGameStart = () => {
    const tableEl = document.querySelector(tableSelector);
    if (!tableEl || prefersReducedMotion()) {
      return;
    }
    tableEl.classList.remove('game-starting');
    void tableEl.offsetWidth;
    tableEl.classList.add('game-starting');
    window.setTimeout(() => tableEl.classList.remove('game-starting'), 1600);
  };

  let stateSnapshot = {
    started: currentGameStarted,
    centerCount: null,
    penaltyCount: null,
    turnId: null,
    winnerId: null,
    faceChances: 0
  };

  // Sons et retours visuels pilotés par les différences d'état successives.
  const applyStateFeedback = (state, lastAction, started) => {
    const prev = stateSnapshot;
    const next = {
      started: Boolean(started),
      centerCount: state ? toFiniteCount(state.center_count) : null,
      penaltyCount: state ? toFiniteCount(state.penalty_count) : null,
      turnId: state ? parseId(state.turn) : null,
      winnerId:
        state && state.winner !== undefined && state.winner !== null
          ? parseId(state.winner)
          : null,
      faceChances: state ? toFiniteCount(state.face_chances) : 0
    };
    stateSnapshot = next;

    const actionType =
      lastAction && typeof lastAction.type === 'string' ? lastAction.type : '';
    const isSlapAction = actionType.indexOf('slap') === 0;

    if (next.started && !prev.started) {
      playSound('start');
      animateGameStart();
    }
    if (!next.started) {
      return;
    }

    if (next.winnerId !== null) {
      if (prev.winnerId === null) {
        playSound(
          currentUserId !== null && next.winnerId === currentUserId
            ? 'win'
            : 'end'
        );
        launchConfetti();
      }
      return;
    }

    // Les tapes ont leurs propres sons (gérés avec le lastAction dédupliqué).
    if (!isSlapAction) {
      if (prev.centerCount !== null && next.centerCount !== null) {
        if (next.centerCount > prev.centerCount) {
          playSound('card');
        } else if (
          next.centerCount < prev.centerCount &&
          lastAction &&
          lastAction.collected
        ) {
          playSound('collect');
        }
      }
      if (
        prev.penaltyCount !== null &&
        next.penaltyCount !== null &&
        next.penaltyCount > prev.penaltyCount
      ) {
        playSound('penalty');
      }
    }

    if (next.faceChances > 0 && prev.faceChances === 0) {
      playSound('face');
    }

    if (
      currentUserId !== null &&
      next.turnId === currentUserId &&
      prev.turnId !== currentUserId
    ) {
      playSound('turn');
      // Plus de bandeau « À vous de jouer ! » : le halo orange sur le paquet
      // suffit à indiquer que c'est notre tour.
    }
  };

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
  // Vrai quand on a déjà gagné le pli et qu'un ramassage est en attente : un
  // clic au centre est alors un simple ramassage, pas une tape.
  let pendingCollectForCurrentUser = false;

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
    if (slapBtn) {
      slapBtn.classList.toggle('slap-armed', isAvailable);
    }
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

  // Horodatage de la dernière tape déclenchée localement : sert à afficher la
  // main immédiatement au clic, sans attendre la résolution serveur, tout en
  // évitant d'en afficher une seconde quand la résolution de NOTRE tape arrive.
  let localSlapHandTs = 0;

  // Ajoute la main géante ✋ sur la table (jamais vidée, contrairement au tas
  // central). kind : 'success' | 'fail' | 'pending' (neutre, au moment du clic).
  const spawnSlapHand = (kind) => {
    if (prefersReducedMotion()) {
      return;
    }
    const tableEl = document.querySelector(tableSelector);
    if (!tableEl) {
      return;
    }
    const hand = document.createElement('div');
    hand.className = `slap-hand-effect ${kind || 'pending'}`;
    hand.textContent = '✋';
    tableEl.appendChild(hand);
    setTimeout(() => hand.remove(), 800);
  };

  // Retour immédiat au clic : on « claque » la main tout de suite, puis on
  // envoie la tape au serveur (dont la résolution, différée par la fenêtre de
  // grâce, ne fera plus que colorer la table en vert/rouge).
  const triggerLocalSlap = () => {
    // Si l'on a déjà remporté le pli et qu'on clique au centre pour ramasser,
    // ce n'est pas une tape : on ne montre ni la main ni la secousse, on envoie
    // simplement l'action (le serveur la traite comme un ramassage).
    if (!pendingCollectForCurrentUser) {
      localSlapHandTs = Date.now();
      spawnSlapHand('pending');
      playSound('pending');
    }
    wsSend({ type: 'slap' });
  };

  // Le bouton « TAPER ! » passe désormais par le retour immédiat (auparavant un
  // onclick inline appelait directement wsSend, sans afficher la main).
  if (slapBtn) {
    slapBtn.addEventListener('click', triggerLocalSlap);
  }

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
    
    // Prevent double firing if the state is merely refreshing
    if (actionType === previous) {
      return;
    }
    
    tableEl.dataset.lastActionType = actionType;
    
    if (actionType === 'slap_resolved' || actionType === 'slap_invalid' || actionType === 'slap_none') {
      const isSuccess = actionType === 'slap_resolved';
      playSlapFeedback(tableEl, isSuccess ? 'success' : 'fail');

      // Si l'on vient de taper soi-même, la main neutre a déjà été affichée au
      // clic : on ne la redouble pas (la table clignote quand même en
      // vert/rouge). Sinon (tape d'un autre joueur), on affiche la main colorée.
      const isOwnRecentSlap = Date.now() - localSlapHandTs < 1500;
      if (isOwnRecentSlap) {
        localSlapHandTs = 0;
      } else {
        spawnSlapHand(isSuccess ? 'success' : 'fail');
      }
    } else {
      playSlapFeedback(tableEl, null);
    }
  };

  const parseGraceMs = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, value);
    }
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
    return null;
  };

  const parseNsValue = (rawValue) => {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return rawValue;
    }
    if (typeof rawValue === 'string') {
      const parsed = Number.parseInt(rawValue, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const formatReactionTimeNs = (rawValue) => {
    const nsValue = parseNsValue(rawValue);
    if (!Number.isFinite(nsValue)) {
      return null;
    }
    if (nsValue < 1e9) {
      return `${(nsValue / 1e6).toFixed(2)} ms`;
    }
    return `${(nsValue / 1e9).toFixed(2)} s`;
  };

  const formatNsKey = (rawValue) => {
    const parsed = parseNsValue(rawValue);
    return Number.isFinite(parsed) ? String(parsed) : '';
  };

  const slapOverlayManager = (() => {
    let overlayEl = null;
    let hideTimerId = null;
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

    const setPendingIndicator = (isActive) => {
      const tableEl = document.querySelector(tableSelector);
      if (tableEl) {
        tableEl.classList.toggle('slap-pending', Boolean(isActive));
      }
      const centerPileEl = document.getElementById('center-pile');
      if (centerPileEl) {
        centerPileEl.classList.toggle('slap-pending', Boolean(isActive));
      }
    };

    const stopAnimationHandler = () => {
      if (overlayEl && currentAnimationHandler) {
        overlayEl.removeEventListener('animationend', currentAnimationHandler);
        currentAnimationHandler = null;
      }
    };

    const clearHideTimer = () => {
      if (hideTimerId !== null) {
        window.clearTimeout(hideTimerId);
        hideTimerId = null;
      }
    };

    const hideOverlayElement = () => {
      if (!overlayEl) {
        return;
      }
      overlayEl.classList.remove('slap-overlay-visible', 'slap-overlay-animate');
      overlayEl.setAttribute('aria-hidden', 'true');
      overlayEl.innerHTML = '';
    };

    const hide = () => {
      clearHideTimer();
      stopAnimationHandler();
      hideOverlayElement();
      setPendingIndicator(false);
    };

    const prepareOverlay = () => {
      const overlay = ensureOverlay();
      if (!overlay) {
        return null;
      }
      stopAnimationHandler();
      clearHideTimer();
      setPendingIndicator(false);
      overlay.innerHTML = '';
      overlay.classList.remove('slap-overlay-animate');
      overlay.classList.add('slap-overlay-visible');
      overlay.setAttribute('aria-hidden', 'false');
      return overlay;
    };

    const scheduleHide = (delay) => {
      clearHideTimer();
      if (!Number.isFinite(delay)) {
        return;
      }
      if (delay <= 0) {
        return;
      }
      hideTimerId = window.setTimeout(() => {
        hideTimerId = null;
        hide();
      }, delay);
    };

    const showResolution = (action, playersById) => {
      const overlay = prepareOverlay();
      if (!overlay) {
        return;
      }

      const content = document.createElement('div');
      content.className = 'slap-overlay-content';

      const title = document.createElement('h3');
      title.textContent = 'Taper réussi !';
      content.appendChild(title);

      const winner = action && action.winner ? action.winner : null;
      const winnerId = winner ? parseId(winner.userId) : null;
      const winnerTs = parseNsValue(winner && winner.t_ns !== undefined ? winner.t_ns : null);
      const winnerReaction = parseNsValue(
        winner && winner.reaction_ns !== undefined ? winner.reaction_ns : null
      );
      const baselineNs = parseNsValue(
        action && action.baselineNs !== undefined ? action.baselineNs : null
      );
      const winnerName =
        (winnerId !== null && playersById.get(winnerId)) ||
        (winnerId !== null ? `Joueur ${winnerId}` : 'Gagnant');
      const winnerLine = document.createElement('p');
      winnerLine.className = 'slap-overlay-winner';
      winnerLine.textContent = 'Gagnant : ';
      const winnerStrong = document.createElement('strong');
      winnerStrong.textContent = winnerName;
      winnerLine.appendChild(winnerStrong);
      const winnerReactionNs = Number.isFinite(winnerReaction)
        ? winnerReaction
        : Number.isFinite(winnerTs) && Number.isFinite(baselineNs)
        ? Math.max(0, winnerTs - baselineNs)
        : null;
      if (Number.isFinite(winnerReactionNs)) {
        const formattedWinnerTime = formatReactionTimeNs(winnerReactionNs);
        if (formattedWinnerTime) {
          const winnerTimeSpan = document.createElement('span');
          winnerTimeSpan.textContent = ` (${formattedWinnerTime})`;
          winnerLine.appendChild(winnerTimeSpan);
        }
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
        candidates.forEach((candidate) => {
          const li = document.createElement('li');
          const cid = candidate ? parseId(candidate.userId) : null;
          const candidateName =
            (cid !== null && playersById.get(cid)) ||
            (cid !== null ? `Joueur ${cid}` : 'Inconnu');
          const ts = parseNsValue(
            candidate && candidate.t_ns !== undefined ? candidate.t_ns : null
          );
          const reactionNs = parseNsValue(
            candidate && candidate.reaction_ns !== undefined ? candidate.reaction_ns : null
          );
          let text = candidateName;
          let displayReaction = Number.isFinite(reactionNs) ? reactionNs : null;
          if (displayReaction === null && Number.isFinite(ts) && Number.isFinite(baselineNs)) {
            displayReaction = Math.max(0, ts - baselineNs);
          }
          if (Number.isFinite(displayReaction)) {
            const formattedCandidateTime = formatReactionTimeNs(displayReaction);
            if (formattedCandidateTime) {
              text += ` - ${formattedCandidateTime}`;
            }
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
      scheduleHide(SLAP_OVERLAY_DURATION_MS + 200);
    };

    const showPending = (graceMs) => {
      setPendingIndicator(true);
      stopAnimationHandler();
      clearHideTimer();
      hideOverlayElement();

      const numericGrace = parseGraceMs(graceMs);
      if (numericGrace !== null) {
        scheduleHide(numericGrace + 200);
      }
    };

    const clearPendingIndicator = () => {
      setPendingIndicator(false);
    };

    return {
      showResolution,
      showPending,
      hide,
      clearPendingIndicator
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

      const crown = document.createElement('div');
      crown.className = 'winner-crown';
      crown.textContent = '👑';
      crown.setAttribute('aria-hidden', 'true');
      content.appendChild(crown);

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
      const winnerReactionKey = (() => {
        if (lastAction.winner && lastAction.winner.reaction_ns !== undefined) {
          return formatNsKey(lastAction.winner.reaction_ns);
        }
        if (lastAction.winner && lastAction.winner.t_ns !== undefined) {
          return formatNsKey(lastAction.winner.t_ns);
        }
        return '';
      })();
      const baselineKey = formatNsKey(lastAction.baselineNs);
      const candidates = Array.isArray(lastAction.candidates)
        ? lastAction.candidates.map((candidate) => {
            const cid = candidate ? parseId(candidate.userId) : null;
            const reactionPart = candidate
              ? candidate.reaction_ns !== undefined
                ? formatNsKey(candidate.reaction_ns)
                : candidate.t_ns !== undefined
                ? formatNsKey(candidate.t_ns)
                : ''
              : '';
            return `${cid !== null ? cid : ''}:${reactionPart}`;
          })
        : [];
      return `${type}:${winnerId !== null ? winnerId : ''}:${winnerReactionKey}:${baselineKey}:${candidates.join(',')}`;
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

  const handleStateLastAction = (
    lastAction,
    playersById,
    previousCounts,
    nextCounts,
    graceMs
  ) => {
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

    if (lastAction.type === 'slap_pending') {
      playSound('pending');
      slapOverlayManager.showPending(graceMs);
      return;
    }

    slapOverlayManager.clearPendingIndicator();

    if (lastAction.type === 'slap_resolved') {
      playSound('slapWin');
      slapOverlayManager.showResolution(lastAction, playersById);
      return;
    }

    slapOverlayManager.hide();

    if (lastAction.type === 'slap_invalid') {
      playSound('slapFail');
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

      li.appendChild(createAvatarEl(userId, username));
      const nameEl = document.createElement('strong');
      nameEl.textContent = username;
      li.appendChild(nameEl);

      if (started) {
        li.classList.remove('player-ready', 'player-waiting');
      } else {
        const isReady = readySet.has(userId);
        const status = document.createElement('span');
        status.className = `status ${isReady ? 'status-ready' : 'status-waiting'}`;
        status.textContent = isReady ? 'prêt' : 'en attente';
        li.appendChild(status);

        const readyBtn = document.createElement('button');
        readyBtn.className = 'ready-btn';
        readyBtn.type = 'button';
        readyBtn.textContent = isReady ? "Annuler l'état prêt" : 'Se déclarer prêt';
        readyBtn.setAttribute('aria-pressed', isReady ? 'true' : 'false');
        if (currentUserId === null || userId !== currentUserId) {
          readyBtn.disabled = true;
          readyBtn.setAttribute('aria-disabled', 'true');
        } else {
          const nextValue = !isReady;
          readyBtn.addEventListener('click', () =>
            window.wsSend({ type: 'ready', value: nextValue })
          );
        }
        li.appendChild(readyBtn);

        li.classList.toggle('player-ready', isReady);
        li.classList.toggle('player-waiting', !isReady);
      }

      fragment.appendChild(li);
    });

    playersList.innerHTML = '';
    playersList.appendChild(fragment);
    renderOptionsSummary();
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
      // Ignore concurrency block silently (just drops the input)
      if (msg.error === 'slap-in-progress') return; 

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
      const graceMs = msg.type === 'state' ? parseGraceMs(msg.graceMs) : null;

      renderTable(state, players, msg.lastAction, playersById);

      handleStateLastAction(
        msg.lastAction,
        playersById,
        previousCountsMap,
        nextCountsMap,
        graceMs
      );
      previousCountsMap = nextCountsMap;

      applyStateFeedback(state, msg.lastAction, started);

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

    triggerLocalSlap();
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

  const roomCodeBadge = document.getElementById('room-code-badge');
  if (roomCodeBadge) {
    roomCodeBadge.addEventListener('click', () => {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        return;
      }
      navigator.clipboard
        .writeText(roomCode)
        .then(() => {
          roomCodeBadge.classList.add('copied');
          const hint = roomCodeBadge.querySelector('.room-code-badge__hint');
          if (hint) {
            hint.textContent = 'copié !';
          }
          window.setTimeout(() => {
            roomCodeBadge.classList.remove('copied');
            if (hint) {
              hint.textContent = 'copier';
            }
          }, 1600);
        })
        .catch(() => {});
    });
  }

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
      triggerLocalSlap();
    } else if (event.code === 'Enter') {
      event.preventDefault();
      wsSend({ type: 'play' });
    }
  });

  // Indices à la française : Valet, Dame, Roi.
  const RANK_DISPLAY = { A: 'A', K: 'R', Q: 'D', J: 'V', T: '10' };
  const COURT_RANKS = new Set(['J', 'Q', 'K']);

  // Positions (en % de la carte) des symboles pour les cartes numérales,
  // reproduisant la disposition d'une vraie carte à jouer.
  const PIP_LAYOUTS = {
    2: [[50, 16], [50, 84]],
    3: [[50, 16], [50, 50], [50, 84]],
    4: [[28, 16], [72, 16], [28, 84], [72, 84]],
    5: [[28, 16], [72, 16], [50, 50], [28, 84], [72, 84]],
    6: [[28, 16], [72, 16], [28, 50], [72, 50], [28, 84], [72, 84]],
    7: [[28, 16], [72, 16], [50, 33], [28, 50], [72, 50], [28, 84], [72, 84]],
    8: [[28, 16], [72, 16], [50, 33], [28, 50], [72, 50], [50, 67], [28, 84], [72, 84]],
    9: [[28, 16], [72, 16], [28, 39], [72, 39], [50, 50], [28, 61], [72, 61], [28, 84], [72, 84]],
    T: [[28, 16], [72, 16], [50, 27], [28, 39], [72, 39], [28, 61], [72, 61], [50, 73], [28, 84], [72, 84]]
  };

  // Cartes empilées (superposées) au centre, différenciées par leur rotation,
  // selon un cycle qui se répète toutes les trois cartes (index absolu % 3) :
  //  - 1re : droite, légèrement décalée vers le HAUT (pour rester visible une
  //          fois les deux cartes suivantes posées par-dessus) ;
  //  - 2e  : légère rotation à gauche → son coin haut-gauche dépasse à gauche ;
  //  - 3e  : légère rotation à droite → son coin haut-droit dépasse à droite.
  // La rotation étant fixée par l'index absolu, les cartes déjà posées ne
  // bougent pas ; seule la nouvelle vient se poser par-dessus.
  const CENTER_PILE_SLOTS = [
    { x: 0, y: -16, rot: 0 },
    { x: -9, y: 0, rot: -13 },
    { x: 9, y: 0, rot: 13 },
  ];

  function formatRankDisplay(rank) {
    return RANK_DISPLAY[rank] || rank;
  }

  function buildCardFace(card) {
    const el = document.createElement('div');
    el.className = 'card-visual playing-card';
    if (!card || card.length < 2) {
      return el;
    }
    const rank = card[0];
    const suit = card[1];
    const suitSymbol = SUIT_SYMBOLS[suit] || '';
    if (suit === 'H' || suit === 'D') {
      el.classList.add('red');
    }

    // Rang aux QUATRE coins : ainsi, quel que soit le sens de rotation d'une
    // carte dans le tas, un coin chiffré reste visible.
    ['pc-corner--top', 'pc-corner--top-right', 'pc-corner--bottom', 'pc-corner--bottom-left'].forEach((positionClass) => {
      const corner = document.createElement('span');
      corner.className = `pc-corner ${positionClass}`;
      const cornerRank = document.createElement('span');
      cornerRank.className = 'pc-corner-rank';
      cornerRank.textContent = formatRankDisplay(rank);
      const cornerSuit = document.createElement('span');
      cornerSuit.className = 'pc-corner-suit';
      cornerSuit.textContent = suitSymbol;
      corner.appendChild(cornerRank);
      corner.appendChild(cornerSuit);
      el.appendChild(corner);
    });

    if (rank === 'A') {
      const center = document.createElement('span');
      center.className = 'pc-center pc-ace';
      center.textContent = suitSymbol;
      el.appendChild(center);
    } else if (COURT_RANKS.has(rank)) {
      const center = document.createElement('span');
      center.className = 'pc-center pc-court';
      const frame = document.createElement('span');
      frame.className = 'pc-court-frame';
      const letter = document.createElement('span');
      letter.className = 'pc-court-letter';
      letter.textContent = formatRankDisplay(rank);
      const courtSuit = document.createElement('span');
      courtSuit.className = 'pc-court-suit';
      courtSuit.textContent = suitSymbol;
      frame.appendChild(letter);
      frame.appendChild(courtSuit);
      center.appendChild(frame);
      el.appendChild(center);
    } else {
      const center = document.createElement('span');
      center.className = 'pc-center pc-pips';
      const layout = PIP_LAYOUTS[rank] || [];
      layout.forEach(([x, y]) => {
        const pip = document.createElement('span');
        pip.className = 'pc-pip';
        if (y > 50) {
          pip.classList.add('pc-pip--flip');
        }
        pip.style.left = `${x}%`;
        pip.style.top = `${y}%`;
        pip.textContent = suitSymbol;
        center.appendChild(pip);
      });
      el.appendChild(center);
    }

    const readable = formatCardName(card);
    if (readable) {
      el.setAttribute('aria-label', readable);
      el.title = readable;
    }
    return el;
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

        const username = player.username || `Joueur ${index + 1}`;
        let safeCount = null;
        if (state) {
          const rawCount = counts[key];
          const count = typeof rawCount === 'number' ? rawCount : Number.parseInt(rawCount, 10);
          safeCount = Number.isFinite(count) ? count : 0;
        }

        const deckCard = document.createElement('div');
        deckCard.className = 'deck-card';
        // Épaisseur visuelle du paquet selon le nombre de cartes restantes.
        const stackLevel =
          safeCount === null ? 1 : Math.min(3, Math.ceil(safeCount / 18));
        deckCard.dataset.stack = String(stackLevel);
        const cardBack = document.createElement('div');
        cardBack.className = 'card-back';
        deckCard.appendChild(cardBack);
        deckCard.appendChild(createAvatarEl(userId, username));
        if (safeCount !== null) {
          const countBadge = document.createElement('span');
          countBadge.className = 'deck-count-badge';
          countBadge.textContent = String(safeCount);
          deckCard.appendChild(countBadge);
        }
        deckContent.appendChild(deckCard);

        const info = document.createElement('div');
        info.className = 'deck-info';

        const title = document.createElement('h3');
        const titleName = document.createElement('span');
        titleName.className = 'deck-name';
        titleName.textContent = username;
        title.appendChild(titleName);
        info.appendChild(title);
        deck.title = username;

        const countEl = document.createElement('p');
        countEl.className = 'deck-count';
        if (safeCount === null) {
          countEl.textContent = 'En attente…';
        } else {
          countEl.textContent = `${safeCount} carte${safeCount > 1 ? 's' : ''}`;
        }
        info.appendChild(countEl);

        deckContent.appendChild(info);

        deck.classList.toggle('deck-empty', safeCount === 0);

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

    const currentUserDeckIndex =
      currentUserKey !== null
        ? deckElements.findIndex(
            (deck) => deck.dataset.userId === currentUserKey
          )
        : -1;

    const totalDecks = deckElements.length;
    decksContainer.dataset.playerCount = String(totalDecks);
    decksContainer.classList.toggle('decks-crowded', totalDecks >= 5);

    if (totalDecks === 1) {
      const deck = deckElements[0];
      deck.style.left = '50%';
      deck.style.top = '78%';
      deck.classList.add('player-deck-solo', 'player-deck-bottom', 'player-deck-self');
      deck.classList.remove('player-deck-top', 'player-deck-left', 'player-deck-right');
      deck.style.zIndex = '9';
    } else if (totalDecks >= 2) {
      // Disposition en éventail : le joueur local occupe le bas de la table,
      // les adversaires se répartissent sur l'arc supérieur (par le haut).
      // Les côtés restent ainsi dégagés pour le tas central et les pénalités,
      // ce qui évite les chevauchements sur petits écrans.
      const hasCurrentUserDeck = currentUserDeckIndex >= 0;
      const anchorIndex = hasCurrentUserDeck ? currentUserDeckIndex : 0;
      const opponents = totalDecks - 1;

      const containerRect = decksContainer.getBoundingClientRect();
      const sampleDeck =
        deckElements.length > 1
          ? deckElements[anchorIndex === 0 ? 1 : 0]
          : deckElements[0];
      const sampleDeckRect =
        typeof sampleDeck.getBoundingClientRect === 'function'
          ? sampleDeck.getBoundingClientRect()
          : null;
      const halfWidthPercent =
        sampleDeckRect && containerRect.width
          ? (sampleDeckRect.width / 2 / containerRect.width) * 100
          : 12;
      const halfHeightPercent =
        sampleDeckRect && containerRect.height
          ? (sampleDeckRect.height / 2 / containerRect.height) * 100
          : 9;

      const desiredX = totalDecks <= 3 ? 46 : totalDecks <= 5 ? 50 : 53;
      const desiredY = totalDecks <= 3 ? 48 : totalDecks <= 5 ? 51 : 53;
      // Horizontalement, le bord du paquet (rayon + demi-largeur) doit rester
      // dans le conteneur, sinon les joueurs sortent de l'écran ou se
      // chevauchent quand ils sont nombreux. Verticalement on tolère un léger
      // débordement sur le rebord de la table (haut/bas) pour bien écarter les
      // paquets du tas central.
      const radiusX = Math.min(desiredX, Math.max(28, 50 - halfWidthPercent - 1));
      const radiusY = Math.min(desiredY, Math.max(32, 50 - halfHeightPercent + 4));

      deckElements.forEach((deck, idx) => {
        const relativeIndex = (idx - anchorIndex + totalDecks) % totalDecks;
        let angleDeg;
        if (relativeIndex === 0) {
          angleDeg = 90; // bas de la table
        } else {
          // Éventail dans la moitié supérieure uniquement (de ~180° à ~360°
          // en passant par le sommet 270°). Les adversaires ne descendent
          // jamais sous la ligne médiane, ce qui laisse toute la zone basse
          // libre pour le tas de pénalité, même à 8 joueurs.
          const arcSpan = 200;
          const arcStart = 270 - arcSpan / 2; // 170°
          angleDeg = arcStart + ((relativeIndex - 0.5) / opponents) * arcSpan;
        }
        const angleRad = (angleDeg * Math.PI) / 180;
        const x = 50 + radiusX * Math.cos(angleRad);
        const y = 50 + radiusY * Math.sin(angleRad);
        deck.style.left = `${x}%`;
        deck.style.top = `${y}%`;
        const isTop = y <= 50;
        deck.classList.toggle('player-deck-top', isTop);
        deck.classList.toggle('player-deck-bottom', !isTop);
        deck.classList.toggle('player-deck-left', x < 50 - 0.5);
        deck.classList.toggle('player-deck-right', x > 50 + 0.5);
        deck.classList.toggle(
          'player-deck-self',
          hasCurrentUserDeck && idx === currentUserDeckIndex
        );
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
    pendingCollectForCurrentUser = isCollectWinner;
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
      Boolean(state) && !hasWinner && hasCenterPileCards;
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
      const isNewTopCard =
        stateSnapshot.centerCount !== null &&
        centerCount > stateSnapshot.centerCount;

      // Chaque carte occupe l'une des TROIS positions du cycle selon sa position
      // ABSOLUE dans le tas (index % 3) : les cartes déjà posées ne bougent pas.
      // On garde plusieurs cartes empilées en dessous pour que le tas
      // s'épaississe (les cartes du dessous ne disparaissent pas). Le client ne
      // connaît que les dernières faces (last_four_center) ; les cartes plus
      // profondes sont dessinées comme une tranche neutre.
      const knownCards = cardsToRender;
      const knownStartAbs = Math.max(totalCount - knownCards.length, 0);
      const PILE_DEPTH = 8; // nombre de cartes empilées visibles au maximum
      const startAbs = Math.max(totalCount - PILE_DEPTH, 0);

      for (let absIndex = startAbs; absIndex < totalCount; absIndex += 1) {
        const idx = absIndex - startAbs;
        const isKnown = absIndex >= knownStartAbs;
        const pileCard = buildCardFace(isKnown ? knownCards[absIndex - knownStartAbs] : null);
        pileCard.classList.add('center-card');
        if (!isKnown) {
          pileCard.classList.add('center-card--buried');
        }

        const slot = CENTER_PILE_SLOTS[absIndex % CENTER_PILE_SLOTS.length];
        // Micro-décalages déterministes (stables par carte) : la pose paraît
        // plus naturelle sans « sauter » à chaque rafraîchissement.
        const jitterRot = ((absIndex * 73) % 9) - 4; // -4°..+4°
        const jitterX = ((absIndex * 53) % 7) - 3; // -3..+3 px
        const jitterY = ((absIndex * 37) % 7) - 3; // -3..+3 px
        pileCard.style.transform =
          `translate(calc(-50% + ${slot.x + jitterX}px), calc(-50% + ${slot.y + jitterY}px)) rotate(${slot.rot + jitterRot}deg)`;
        // z par ordre d'arrivée : la dernière carte posée est au-dessus.
        pileCard.style.zIndex = String(10 + idx);
        if (isNewTopCard && absIndex === totalCount - 1 && !prefersReducedMotion()) {
          pileCard.classList.add('card-enter');
        }

        stack.appendChild(pileCard);
      }

      centerPileEl.appendChild(stack);

      const countBadge = document.createElement('span');
      countBadge.className = 'center-count-badge';
      countBadge.textContent = `${totalCount} carte${totalCount > 1 ? 's' : ''}`;
      centerPileEl.appendChild(countBadge);
    }

    // Défi figure en cours : bandeau au-dessus du tas + joueur mis en évidence.
    const faceChances = state ? toFiniteCount(state.face_chances) : 0;
    const challengedId = state ? parseId(state.waiting_for_face_from) : null;
    const challengedKey = challengedId !== null ? String(challengedId) : null;
    if (faceChances > 0 && !hasWinner) {
      const challengeBadge = document.createElement('div');
      challengeBadge.className = 'face-challenge-badge';
      challengeBadge.setAttribute('role', 'status');
      const badgeTitle = document.createElement('strong');
      badgeTitle.textContent = 'Défi figure';
      const badgeDetail = document.createElement('span');
      badgeDetail.textContent = `${faceChances} essai${faceChances > 1 ? 's' : ''} restant${faceChances > 1 ? 's' : ''}`;
      challengeBadge.appendChild(badgeTitle);
      challengeBadge.appendChild(badgeDetail);
      centerPileEl.appendChild(challengeBadge);
    }
    deckElements.forEach((deck) => {
      deck.classList.toggle(
        'deck-challenged',
        challengedKey !== null && faceChances > 0 && deck.dataset.userId === challengedKey
      );
    });
  }
})();
