/*
 * Interface propre au jeu « Le 1% » (bluff, enchères, dés).
 *
 * Indépendante de room.js (Bataille Corse) : chaque jeu possède son interface.
 * Rend l'état reçu du serveur pour chaque phase : enchères, vote, révélation,
 * récompense (dés + bonus). Les mains adverses restent cachées (l'état est
 * masqué par joueur côté serveur).
 */
(function () {
  'use strict';

  const root = document.getElementById('up-root');
  if (!root) {
    return;
  }

  const roomCode = root.dataset.roomCode;
  const meId = Number.parseInt(root.dataset.currentUserId, 10);
  const isHost = root.dataset.isHost === 'true';

  const CATEGORY_LABELS = {
    shark: 'Requin', lightning: 'Éclair', clover: 'Trèfle', star: 'Étoile', comet: 'Comète',
  };
  const CATEGORY_ICONS = {
    shark: '🦈', lightning: '⚡', clover: '🍀', star: '⭐', comet: '☄️',
  };
  const BONUS_LABELS = {
    reroll: "Relance d'un dé", draw2: 'Pioche 2 récompenses', steal: "Vol d'une carte",
  };
  const BONUS_ICONS = { reroll: '🎲', draw2: '🃏', steal: '🫳' };

  const ERROR_MESSAGES = {
    'not-ready': 'Tous les joueurs doivent être prêts.',
    'not-enough-players': 'Il faut au moins deux joueurs.',
    'game-not-started': "La partie n'a pas encore commencé.",
    'game-over': 'La partie est terminée.',
    'not-host': "Seul l'hôte peut faire cela.",
    'bad-phase': "Ce n'est pas le moment de faire cela.",
    'not-your-turn': "Ce n'est pas votre tour.",
    'invalid-category': 'Catégorie invalide.',
    'bid-too-low': 'Votre enchère doit être plus haute.',
    'nothing-to-doubt': 'Aucune enchère à contester.',
    'not-a-voter': "Vous ne pouvez pas voter sur ce duel.",
    'already-voted': 'Vous avez déjà voté.',
    'invalid-vote': 'Vote invalide.',
    'no-actions-left': "Plus d'action disponible.",
    'cannot-reroll': 'Relance impossible maintenant.',
    'no-such-bonus': "Vous ne possédez pas ce bonus.",
    'nothing-to-steal': 'Rien à voler chez cette cible.',
    'invalid-target': 'Cible invalide.',
    'invalid-index': 'Carte indisponible.',
    'unknown-action': 'Action inconnue.',
  };

  const $ = (id) => document.getElementById(id);
  const playersSection = $('players-section');
  const playersListEl = $('up-players-list');
  const startBtn = $('start-btn');
  const stopBtn = $('stop-btn');
  const restartBtn = $('restart-btn');
  const returnLobbyBtn = $('return-lobby-btn');
  const board = $('up-board');
  const waiting = $('up-waiting');
  const statusEl = $('up-status');
  const centerEl = $('up-center');
  const handEl = $('up-hand');
  const playersZone = $('up-players');
  const drawCountEl = $('up-draw-count');
  const discardCountEl = $('up-discard-count');
  // bidding
  const bidSection = $('up-bid-section');
  const currentBidEl = $('up-current-bid');
  const bidPanel = $('up-bid-panel');
  const bidCategory = $('up-bid-category');
  const bidValue = $('up-bid-value');
  const bidBtn = $('up-bid-btn');
  const doubtBtn = $('up-doubt-btn');
  // voting
  const voteSection = $('up-vote-section');
  const voteQuestion = $('up-vote-question');
  const votePanel = $('up-vote-panel');
  const voteAccused = $('up-vote-accused');
  const voteAccuser = $('up-vote-accuser');
  const voteProgress = $('up-vote-progress');
  // reveal
  const revealSection = $('up-reveal-section');
  const revealEl = $('up-reveal');
  // reward
  const rewardSection = $('up-reward-section');
  const rewardInfo = $('up-reward-info');
  const rewardPanel = $('up-reward-panel');
  const diceEls = Array.from(document.querySelectorAll('#up-dice .up-die'));
  const rollBtn = $('up-roll-btn');
  const bonusPanel = $('up-bonus-panel');
  const endRewardBtn = $('up-end-reward-btn');
  const rollMsg = $('up-roll-msg');

  let nameById = new Map();
  let categoriesInit = false;

  const nameOf = (pid) => nameById.get(Number.parseInt(pid, 10)) || `Joueur ${pid}`;
  const num = (v) => Number.parseInt(v, 10);

  // --- WebSocket ----------------------------------------------------------
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws/room/${roomCode}/`);

  window.wsSend = function wsSend(obj) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  };
  const sendAction = (action, extra) =>
    window.wsSend(Object.assign({ type: 'action', action }, extra || {}));

  socket.onopen = () => { if (startBtn && isHost) startBtn.disabled = false; };
  socket.onclose = () => { if (rollMsg) rollMsg.textContent = 'Connexion perdue. Rechargez la page.'; };

  // --- waiting room -------------------------------------------------------
  function renderPlayersList(players, readyIds, started, hostId) {
    if (!playersListEl) return;
    playersListEl.innerHTML = '';
    (players || []).forEach((p) => {
      const uid = num(p.userId);
      const li = document.createElement('li');
      li.className = 'player-row';
      li.dataset.userId = String(uid);
      const strong = document.createElement('strong');
      strong.textContent = p.username || `Joueur ${uid}`;
      li.appendChild(strong);
      if (hostId === uid) {
        const crown = document.createElement('span');
        crown.className = 'host-indicator';
        crown.textContent = ' 👑';
        li.appendChild(crown);
      }
      if (!started) {
        const isReady = readyIds.has(uid);
        const status = document.createElement('span');
        status.className = `status ${isReady ? 'status-ready' : 'status-waiting'}`;
        status.textContent = isReady ? 'prêt' : 'en attente';
        li.appendChild(status);
        if (uid === meId) {
          const btn = document.createElement('button');
          btn.className = 'ready-btn';
          btn.type = 'button';
          btn.textContent = isReady ? "Annuler l'état prêt" : 'Se déclarer prêt';
          btn.addEventListener('click', () => window.wsSend({ type: 'ready', value: !isReady }));
          li.appendChild(btn);
        }
      }
      playersListEl.appendChild(li);
    });
  }

  // --- cartes -------------------------------------------------------------
  function cardEl(card, opts) {
    opts = opts || {};
    const el = document.createElement(opts.clickable ? 'button' : 'div');
    el.className = 'up-card';
    if (opts.clickable) {
      el.type = 'button';
      el.classList.add('up-card--clickable');
    }
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
      el.innerHTML =
        `<span class="up-card__tag">Bonus</span>` +
        `<span class="up-card__icon">${BONUS_ICONS[card.power] || '🎁'}</span>` +
        `<span class="up-card__hint">${BONUS_LABELS[card.power] || card.power}</span>`;
    } else if (card.kind === 'draw') {
      el.classList.add('up-card--draw');
      el.innerHTML =
        `<span class="up-card__icon">${CATEGORY_ICONS[card.category] || '🎴'}</span>` +
        `<span class="up-card__value">${card.value}</span>` +
        `<span class="up-card__hint">${CATEGORY_LABELS[card.category] || card.category}</span>`;
    }
    if (opts.clickable && Number.isInteger(opts.index)) {
      el.addEventListener('click', () => sendAction('take_center', { index: opts.index }));
      el.title = 'Prendre cette carte';
    }
    return el;
  }

  function renderCenter(state) {
    if (!centerEl) return;
    const canTake =
      state.phase === 'reward' && state.reward_player === meId && state.reward_actions_left > 0;
    centerEl.innerHTML = '';
    (state.center || []).forEach((card, idx) => {
      centerEl.appendChild(cardEl(card, { clickable: canTake, index: idx }));
    });
    if (!state.center || !state.center.length) {
      const p = document.createElement('p');
      p.className = 'up-empty';
      p.textContent = 'Centre vide.';
      centerEl.appendChild(p);
    }
  }

  function renderHand(state) {
    if (!handEl) return;
    handEl.innerHTML = '';
    const hand = Array.isArray(state.hand) ? state.hand : [];
    if (!hand.length) {
      const p = document.createElement('p');
      p.className = 'up-empty';
      p.textContent =
        state.in_round && state.in_round.includes(meId)
          ? 'Aucune carte en main.'
          : "Vous n'êtes pas dans la manche en cours.";
      handEl.appendChild(p);
      return;
    }
    const sorted = hand.slice().sort((a, b) =>
      (a.category || '').localeCompare(b.category || '') || (a.value - b.value)
    );
    sorted.forEach((card) => handEl.appendChild(cardEl(card)));
  }

  // --- enchères -----------------------------------------------------------
  function initCategories(categories) {
    if (categoriesInit || !bidCategory) return;
    (categories || []).forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = `${CATEGORY_ICONS[cat] || ''} ${CATEGORY_LABELS[cat] || cat}`.trim();
      bidCategory.appendChild(opt);
    });
    categoriesInit = true;
  }

  function renderBidding(state) {
    const active = state.phase === 'bidding';
    bidSection.hidden = !active;
    if (!active) return;
    initCategories(state.categories);

    if (state.current_bid) {
      const b = state.current_bid;
      currentBidEl.innerHTML =
        `Dernière enchère : <strong>${nameOf(b.player)}</strong> annonce ` +
        `<strong>${b.value}</strong> en ${CATEGORY_ICONS[b.category] || ''} ` +
        `${CATEGORY_LABELS[b.category] || b.category}.`;
    } else {
      currentBidEl.textContent = "Personne n'a encore enchéri dans ce duel.";
    }

    const myTurn = state.turn === meId && state.in_round.includes(meId);
    bidPanel.hidden = !myTurn;
    if (myTurn) {
      const minVal = (state.current_bid ? state.current_bid.value : 0) + 1;
      bidValue.min = String(minVal);
      if (num(bidValue.value) < minVal) bidValue.value = String(minVal);
      doubtBtn.disabled = !state.current_bid;
      doubtBtn.title = state.current_bid ? '' : 'Rien à contester pour le moment';
    }
  }

  // --- vote ---------------------------------------------------------------
  function renderVoting(state) {
    const active = state.phase === 'voting';
    voteSection.hidden = !active;
    if (!active) return;
    const d = state.doubt || {};
    const b = state.current_bid || {};
    voteQuestion.innerHTML =
      `<strong>${nameOf(d.accuser)}</strong> conteste <strong>${nameOf(d.accused)}</strong>. ` +
      `La somme des ${CATEGORY_LABELS[b.category] || b.category} atteint-elle <strong>${b.value}</strong> ?`;
    const isVoter = (state.voters || []).includes(meId);
    const alreadyVoted = (state.voted || []).includes(meId);
    votePanel.hidden = !(isVoter && !alreadyVoted);
    const total = (state.voters || []).length + (state.voted || []).length;
    // voters/voted sont disjoints côté serveur ? voters = non exclus ; voted = ceux ayant voté.
    const remaining = (state.voters || []).filter((v) => !(state.voted || []).includes(v));
    voteProgress.textContent = alreadyVoted
      ? `Vote enregistré. En attente des autres… (${state.votes_count} vote(s))`
      : isVoter
        ? 'À vous de voter.'
        : `En attente des votes… (${state.votes_count} enregistré(s))`;
  }

  // --- révélation ---------------------------------------------------------
  function renderReveal(state) {
    const r = state.last_reveal;
    const show = r && state.phase !== 'voting';
    revealSection.hidden = !show;
    if (!show) return;
    const catLabel = CATEGORY_LABELS[r.category] || r.category;
    const verdict = r.accused_truthful
      ? `L'annonce tenait : <strong>${nameOf(r.accused)}</strong> l'emporte.`
      : `Bluff démasqué : <strong>${nameOf(r.accuser)}</strong> l'emporte.`;
    const contrib = Object.entries(r.contributions || {})
      .map(([pid, v]) => `${nameOf(pid)} : ${v}`)
      .join(' · ');
    const elim = (r.eliminated || []).map(nameOf).join(', ') || 'personne';
    revealEl.innerHTML =
      `<p>Catégorie <strong>${catLabel}</strong> — annoncé <strong>${r.bid}</strong>, ` +
      `réel <strong>${r.actual}</strong>.</p>` +
      `<p>${verdict}</p>` +
      `<p class="up-reveal__detail">Détail : ${contrib}</p>` +
      `<p class="up-reveal__detail">Éliminé(s) ce tour : ${elim}.</p>`;
  }

  // --- récompense ---------------------------------------------------------
  function renderReward(state) {
    const active = state.phase === 'reward';
    rewardSection.hidden = !active;
    if (!active) { return; }
    const mine = state.reward_player === meId;
    rewardInfo.innerHTML = mine
      ? `Vous avez survécu ! Il vous reste <strong>${state.reward_actions_left}</strong> action(s) ` +
        `(prendre une carte au centre ou lancer les dés).`
      : `<strong>${nameOf(state.reward_player)}</strong> survit et joue sa phase de récompense.`;
    rewardPanel.hidden = !mine;
    if (!mine) return;

    rollBtn.disabled = state.reward_actions_left <= 0;
    renderBonusPanel(state);
  }

  function renderBonusPanel(state) {
    bonusPanel.innerHTML = '';
    const myBonuses = (state.bonuses && state.bonuses[String(meId)]) || [];
    if (!myBonuses.length) return;
    const roll = state.last_roll;
    const counts = myBonuses.reduce((acc, p) => ((acc[p] = (acc[p] || 0) + 1), acc), {});
    Object.keys(counts).forEach((power) => {
      const wrap = document.createElement('div');
      wrap.className = 'up-bonus';
      const label = document.createElement('span');
      label.className = 'up-bonus__label';
      label.textContent = `${BONUS_ICONS[power] || '🎁'} ${BONUS_LABELS[power] || power} ×${counts[power]}`;
      wrap.appendChild(label);

      if (power === 'reroll') {
        const canReroll = roll && roll.player === meId && !roll.win && roll.can_reroll;
        [0, 1].forEach((die) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'action-btn up-bonus__btn';
          b.textContent = `Relancer dé ${die + 1}`;
          b.disabled = !canReroll;
          b.addEventListener('click', () => sendAction('use_bonus', { power: 'reroll', die }));
          wrap.appendChild(b);
        });
      } else if (power === 'draw2') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'action-btn up-bonus__btn';
        b.textContent = 'Piocher 2';
        b.addEventListener('click', () => sendAction('use_bonus', { power: 'draw2' }));
        wrap.appendChild(b);
      } else if (power === 'steal') {
        (state.players || []).forEach((pid) => {
          if (pid === meId) return;
          const hasSomething =
            ((state.reward_numbers && state.reward_numbers[String(pid)]) || []).length ||
            ((state.bonuses && state.bonuses[String(pid)]) || []).length;
          if (!hasSomething) return;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'action-btn up-bonus__btn';
          b.textContent = `Voler ${nameOf(pid)}`;
          b.addEventListener('click', () => sendAction('use_bonus', { power: 'steal', target: pid }));
          wrap.appendChild(b);
        });
      }
      bonusPanel.appendChild(wrap);
    });
  }

  function renderDice(state) {
    const roll = state.last_roll;
    if (roll && Array.isArray(roll.dice)) {
      diceEls[0].textContent = roll.dice[0];
      diceEls[1].textContent = roll.dice[1];
      diceEls.forEach((d) => d.classList.toggle('up-die--win', Boolean(roll.win)));
    } else {
      diceEls.forEach((d) => { d.textContent = '–'; d.classList.remove('up-die--win'); });
    }
  }

  // --- zones joueurs ------------------------------------------------------
  function renderPlayersZone(state) {
    if (!playersZone) return;
    playersZone.innerHTML = '';
    (state.players || []).forEach((pid) => {
      const key = String(pid);
      const card = document.createElement('div');
      card.className = 'up-player-zone';
      const inRound = (state.in_round || []).includes(pid);
      const isEliminated = (state.eliminated || []).includes(pid);
      if (pid === state.turn) card.classList.add('is-turn');
      if (pid === meId) card.classList.add('is-self');
      if (isEliminated) card.classList.add('is-eliminated');

      const nums = (state.winning_numbers && state.winning_numbers[key]) || [0];
      const prob = (state.win_probability && state.win_probability[key]) || 0;
      const rewards = (state.reward_numbers && state.reward_numbers[key]) || [];
      const bonuses = (state.bonuses && state.bonuses[key]) || [];
      const hand = (state.counts && state.counts[key]) || 0;
      const bonusText = bonuses.length ? bonuses.map((b) => BONUS_ICONS[b] || '🎁').join(' ') : '—';
      let tag = '';
      if (pid === state.reward_player) tag = '<span class="up-turn-badge">récompense</span>';
      else if (pid === state.turn && state.phase === 'bidding') tag = '<span class="up-turn-badge">enchérit</span>';
      else if (isEliminated) tag = '<span class="up-elim-badge">éliminé</span>';

      card.innerHTML =
        `<div class="up-player-zone__head"><strong>${nameOf(pid)}</strong>${tag}</div>` +
        `<div class="up-player-zone__row">Main : <b>${inRound ? hand : 0}</b> carte${hand > 1 ? 's' : ''}</div>` +
        `<div class="up-player-zone__row">Récompenses : <b>${rewards.length ? rewards.join(', ') : '—'}</b></div>` +
        `<div class="up-player-zone__row">Bonus : <b>${bonusText}</b></div>` +
        `<div class="up-player-zone__win">Numéros gagnants : <b>${nums.join(' · ')}</b>` +
        `<span class="up-prob">${prob}%</span></div>`;
      playersZone.appendChild(card);
    });
  }

  function renderStatus(state, winnerId) {
    if (!statusEl) return;
    if (winnerId !== null) {
      statusEl.innerHTML = `<span class="up-status__win">👑 ${nameOf(winnerId)} rejoint le 1% !</span>`;
      return;
    }
    let txt = '';
    if (state.phase === 'bidding') {
      txt = state.turn === meId ? '🎯 À vous d\'enchérir ou de douter.' : `Enchères — au tour de ${nameOf(state.turn)}.`;
    } else if (state.phase === 'voting') {
      txt = '🗳️ Phase de vote sur le doute.';
    } else if (state.phase === 'reward') {
      txt = state.reward_player === meId ? '🏆 Votre phase de récompense.' : `Phase de récompense de ${nameOf(state.reward_player)}.`;
    }
    statusEl.textContent = txt;
  }

  // --- boucle principale --------------------------------------------------
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'game_unvalidated') {
      window.location.href = '/game/lobby/' + roomCode + '/';
      return;
    }
    if (msg.error) {
      if (rollMsg) rollMsg.textContent = ERROR_MESSAGES[msg.error] || msg.error;
      return;
    }
    if (msg.type !== 'state' && msg.type !== 'player_joined') return;

    const started = Boolean(msg.started);
    const hostId = msg.hostId !== undefined ? num(msg.hostId) : null;
    const players = Array.isArray(msg.players) ? msg.players : [];
    const readyIds = new Set((Array.isArray(msg.ready) ? msg.ready : []).map(num));
    const state = msg.state || null;
    const winnerId =
      state && state.winner !== undefined && state.winner !== null ? num(state.winner) : null;

    nameById = new Map(players.map((p) => [num(p.userId), p.username]));

    if (startBtn) startBtn.style.display = isHost && !started ? '' : 'none';
    if (stopBtn) stopBtn.style.display = isHost && started && winnerId === null ? '' : 'none';
    if (restartBtn) restartBtn.style.display = isHost && winnerId !== null ? '' : 'none';
    if (returnLobbyBtn) returnLobbyBtn.style.display = isHost ? '' : 'none';
    if (playersSection) playersSection.style.display = started ? 'none' : '';
    if (board) board.hidden = !started;
    if (waiting) waiting.hidden = started;

    renderPlayersList(players, readyIds, started, hostId);

    if (started && state) {
      if (drawCountEl) drawCountEl.textContent = state.draw_count ?? 0;
      if (discardCountEl) discardCountEl.textContent = state.discard_count ?? 0;
      renderStatus(state, winnerId);
      renderCenter(state);
      renderHand(state);
      renderBidding(state);
      renderVoting(state);
      renderReveal(state);
      renderReward(state);
      renderDice(state);
      renderPlayersZone(state);

      // Message contextuel sur le dernier lancer / la victoire.
      if (rollMsg) {
        if (winnerId !== null) {
          rollMsg.textContent =
            winnerId === meId ? '👑 Victoire ! Vous rejoignez le 1%.' : `👑 ${nameOf(winnerId)} remporte la partie !`;
        } else if (state.last_roll && state.phase === 'reward') {
          const who = state.last_roll.player === meId ? 'Vous avez' : `${nameOf(state.last_roll.player)} a`;
          rollMsg.textContent = state.last_roll.win
            ? '🎉 Combinaison gagnante !'
            : `${who} obtenu ${state.last_roll.dice[0]} et ${state.last_roll.dice[1]} — raté.`;
        } else {
          rollMsg.textContent = '';
        }
      }
    }
  };

  // --- actions UI ---------------------------------------------------------
  if (bidBtn) bidBtn.addEventListener('click', () => {
    const category = bidCategory.value;
    const value = num(bidValue.value);
    if (category && Number.isFinite(value) && value > 0) {
      sendAction('bid', { category, value });
    }
  });
  if (doubtBtn) doubtBtn.addEventListener('click', () => sendAction('doubt'));
  if (voteAccused) voteAccused.addEventListener('click', () => sendAction('vote', { choice: 'accused' }));
  if (voteAccuser) voteAccuser.addEventListener('click', () => sendAction('vote', { choice: 'accuser' }));
  if (rollBtn) rollBtn.addEventListener('click', () => sendAction('roll'));
  if (endRewardBtn) endRewardBtn.addEventListener('click', () => sendAction('end_reward'));

  // Copie du code de la salle.
  const badge = $('room-code-badge');
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
