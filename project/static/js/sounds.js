/*
 * Moteur audio du jeu — tous les effets sont synthétisés via WebAudio,
 * aucun fichier audio n'est nécessaire.
 *
 * API publique : window.GameSounds
 *   .play(name)   — joue un effet ('card', 'collect', 'slapWin', 'slapFail',
 *                   'pending', 'turn', 'face', 'penalty', 'win', 'end', 'start')
 *   .toggleMute() — bascule le mode muet (persisté dans localStorage)
 *   .isMuted()    — état courant
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'bc-sound-muted';
  const MASTER_VOLUME = 0.5;

  let audioCtx = null;
  let masterGain = null;
  let noiseBuffer = null;
  let muted = false;

  try {
    muted = window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch (err) {
    muted = false;
  }

  const persistMuted = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, muted ? 'true' : 'false');
    } catch (err) {
      /* stockage indisponible : le réglage ne survivra pas au rechargement */
    }
  };

  const ensureContext = () => {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return null;
    }
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
    masterGain.connect(audioCtx.destination);

    const seconds = 1;
    noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * seconds, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return audioCtx;
  };

  // Débloque le contexte audio au premier geste utilisateur (exigence navigateur).
  const unlock = () => {
    ensureContext();
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });

  const applyMuteState = () => {
    if (masterGain && audioCtx) {
      const now = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, now, 0.01);
    }
  };

  /* ----- briques de synthèse ------------------------------------------- */

  const tone = (opts) => {
    const ctx = ensureContext();
    if (!ctx) {
      return;
    }
    const start = ctx.currentTime + (opts.delay || 0);
    const duration = opts.duration || 0.2;
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, start);
    if (opts.freqEnd && opts.freqEnd !== opts.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqEnd), start + duration);
    }
    const gain = ctx.createGain();
    const peak = opts.gain || 0.3;
    const attack = opts.attack !== undefined ? opts.attack : 0.005;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  };

  const noise = (opts) => {
    const ctx = ensureContext();
    if (!ctx || !noiseBuffer) {
      return;
    }
    const start = ctx.currentTime + (opts.delay || 0);
    const duration = opts.duration || 0.08;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.filterType || 'bandpass';
    filter.frequency.setValueAtTime(opts.freq || 2000, start);
    if (opts.freqEnd) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqEnd), start + duration);
    }
    filter.Q.value = opts.q || 0.9;
    const gain = ctx.createGain();
    const peak = opts.gain || 0.25;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + (opts.attack || 0.003));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start(start);
    src.stop(start + duration + 0.05);
  };

  /* ----- effets du jeu --------------------------------------------------- */

  const effects = {
    // Carte posée : petit "swish" feutré + tap sec.
    card() {
      noise({ freq: 3200, freqEnd: 900, duration: 0.07, gain: 0.22, q: 0.7 });
      tone({ type: 'triangle', freq: 210, freqEnd: 150, duration: 0.05, gain: 0.12, delay: 0.015 });
    },

    // Ramassage du tas : rafale de petits frottements de cartes.
    collect() {
      for (let i = 0; i < 5; i += 1) {
        noise({
          freq: 2400 + i * 350,
          freqEnd: 1000,
          duration: 0.05,
          gain: 0.16,
          delay: i * 0.055,
          q: 1.2
        });
      }
      tone({ type: 'sine', freq: 330, freqEnd: 392, duration: 0.16, gain: 0.1, delay: 0.28 });
    },

    // Tape gagnée : claque grave + carillon ascendant victorieux.
    slapWin() {
      tone({ type: 'sine', freq: 190, freqEnd: 55, duration: 0.16, gain: 0.5 });
      noise({ freq: 900, freqEnd: 250, duration: 0.1, gain: 0.35, filterType: 'lowpass' });
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        tone({
          type: 'triangle',
          freq: freq,
          duration: 0.3,
          gain: 0.16,
          delay: 0.09 + idx * 0.06
        });
      });
    },

    // Tape ratée : claque + buzzer descendant dissonant.
    slapFail() {
      tone({ type: 'sine', freq: 170, freqEnd: 50, duration: 0.14, gain: 0.4 });
      tone({ type: 'sawtooth', freq: 220, freqEnd: 98, duration: 0.34, gain: 0.14, delay: 0.06 });
      tone({ type: 'sawtooth', freq: 233, freqEnd: 104, duration: 0.34, gain: 0.12, delay: 0.06 });
    },

    // Tape détectée, arbitrage en cours : tic discret.
    pending() {
      noise({ freq: 5200, duration: 0.03, gain: 0.14, filterType: 'highpass' });
      tone({ type: 'sine', freq: 880, duration: 0.05, gain: 0.08 });
    },

    // À vous de jouer : deux notes de clochette douces.
    turn() {
      tone({ type: 'sine', freq: 880, duration: 0.14, gain: 0.14 });
      tone({ type: 'sine', freq: 1108.7, duration: 0.22, gain: 0.13, delay: 0.11 });
    },

    // Défi figure lancé : accord mineur dramatique.
    face() {
      const notes = [329.63, 392, 466.16];
      notes.forEach((freq, idx) => {
        tone({ type: 'triangle', freq: freq, duration: 0.4, gain: 0.13, delay: idx * 0.07 });
      });
      tone({ type: 'sine', freq: 110, duration: 0.5, gain: 0.16, delay: 0.05 });
    },

    // Pénalité : coup sourd.
    penalty() {
      tone({ type: 'sine', freq: 130, freqEnd: 45, duration: 0.22, gain: 0.35 });
      noise({ freq: 420, freqEnd: 120, duration: 0.12, gain: 0.18, filterType: 'lowpass' });
    },

    // Victoire finale : fanfare + scintillement.
    win() {
      const melody = [
        { freq: 523.25, delay: 0 },
        { freq: 659.25, delay: 0.14 },
        { freq: 783.99, delay: 0.28 },
        { freq: 1046.5, delay: 0.42, duration: 0.7 }
      ];
      melody.forEach((note) => {
        tone({
          type: 'triangle',
          freq: note.freq,
          duration: note.duration || 0.24,
          gain: 0.2,
          delay: note.delay
        });
        tone({
          type: 'sine',
          freq: note.freq * 2,
          duration: note.duration || 0.24,
          gain: 0.07,
          delay: note.delay
        });
      });
      for (let i = 0; i < 6; i += 1) {
        noise({
          freq: 6000 + Math.sin(i * 2.7) * 1500,
          duration: 0.09,
          gain: 0.06,
          delay: 0.5 + i * 0.09,
          filterType: 'highpass'
        });
      }
    },

    // Fin de partie (pour les perdants) : deux notes descendantes sobres.
    end() {
      tone({ type: 'triangle', freq: 392, duration: 0.3, gain: 0.15 });
      tone({ type: 'triangle', freq: 293.66, duration: 0.5, gain: 0.15, delay: 0.22 });
    },

    // Début de partie : montée + bruit de mélange de cartes.
    start() {
      tone({ type: 'sine', freq: 261.63, freqEnd: 523.25, duration: 0.4, gain: 0.15 });
      for (let i = 0; i < 7; i += 1) {
        noise({
          freq: 2000 + (i % 3) * 600,
          freqEnd: 900,
          duration: 0.045,
          gain: 0.14,
          delay: 0.12 + i * 0.05,
          q: 1.4
        });
      }
    }
  };

  /* ----- API publique + bouton muet -------------------------------------- */

  const updateToggleButton = () => {
    const btn = document.getElementById('sound-toggle-btn');
    if (!btn) {
      return;
    }
    const onIcon = btn.querySelector('[data-sound-icon="on"]');
    const offIcon = btn.querySelector('[data-sound-icon="off"]');
    if (onIcon) {
      onIcon.style.display = muted ? 'none' : '';
    }
    if (offIcon) {
      offIcon.style.display = muted ? '' : 'none';
    }
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      muted ? 'Activer les effets sonores' : 'Couper les effets sonores'
    );
    btn.title = muted ? 'Activer le son' : 'Couper le son';
    btn.classList.toggle('sound-muted', muted);
  };

  window.GameSounds = {
    play(name) {
      if (muted) {
        return;
      }
      const effect = effects[name];
      if (!effect) {
        return;
      }
      const ctx = ensureContext();
      // Contexte encore verrouillé (aucun geste utilisateur) : on ignore sans erreur.
      if (!ctx || ctx.state !== 'running') {
        return;
      }
      try {
        effect();
      } catch (err) {
        /* un échec audio ne doit jamais casser le jeu */
      }
    },
    toggleMute() {
      muted = !muted;
      persistMuted();
      applyMuteState();
      updateToggleButton();
      if (!muted) {
        this.play('turn');
      }
      return muted;
    },
    isMuted() {
      return muted;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
      btn.addEventListener('click', () => window.GameSounds.toggleMute());
    }
    updateToggleButton();
  });
})();
