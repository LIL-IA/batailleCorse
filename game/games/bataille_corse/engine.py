import random
from collections import deque

from ..base import BaseGameEngine

RANKS = "23456789TJQKA"
RANK_VALUE = {r: i for i, r in enumerate(RANKS, start=2)}
FACE_PENALTIES = {"J": 1, "Q": 2, "K": 3, "A": 4}
PENALTY_STEPS = tuple(range(6))
PENALTY_MODE_FIXED = "fixed"
PENALTY_MODE_SUDDEN_DEATH = "sudden_death"

PENALTY_SUDDEN_DEATH_MAP = {
    "bad_slap_penalty": "bad_slap_sudden_death",
    "bad_play_penalty": "bad_play_sudden_death",
}

def new_deck():
    suits = "CDHS"
    deck = [r+s for r in RANKS for s in suits]
    random.shuffle(deck)
    return deck

class GameEngine(BaseGameEngine):
    DEFAULT_OPTIONS = {
        "allow_sandwich": True,
        "allow_double": True,
        "allow_runs": False,
        "allow_ten_card": True,
        "allow_ten_sum": True,
        "allow_ten_sandwich": True,
        "bad_slap_penalty": 2,
        "bad_play_penalty": 2,
        "bad_slap_sudden_death": False,
        "bad_play_sudden_death": False,
        "deck_mode": "auto",
        "deck_count": 1,
        "eliminated_spam_timeout": 0,
    }

    @classmethod
    def default_options(cls):
        return dict(cls.DEFAULT_OPTIONS)

    @classmethod
    def _coerce_option_value(cls, key, value):
        default = cls.DEFAULT_OPTIONS.get(key)
        if isinstance(default, bool):
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"true", "1", "yes", "on"}:
                    return True
                if lowered in {"false", "0", "no", "off"}:
                    return False
            return bool(value)
        if isinstance(default, int):
            if isinstance(value, bool):
                numeric = int(value)
            elif isinstance(value, (int, float)):
                numeric = int(value)
            elif isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"off", "none", "no", "false", "disable", "disabled"}:
                    return 0
                try:
                    numeric = int(lowered)
                except ValueError:
                    return default
            else:
                return default
            numeric = max(0, numeric)
            if key == "deck_count":
                return cls._normalize_deck_count(numeric)
            if key == "eliminated_spam_timeout":
                return numeric if numeric in (0, 10, 30, 60, -1) else default
            return numeric
        if isinstance(default, str):
            if value is None:
                return default
            if key == "deck_mode":
                return cls._normalize_deck_mode(value)
            return value if isinstance(value, str) else default
        return default

    @classmethod
    def sanitize_options(cls, overrides=None, base=None):
        result = cls.default_options()
        legacy_penalty_mode = None
        override_sudden_death = set()

        def apply(source, track_overrides):
            nonlocal legacy_penalty_mode
            if not source:
                return
            provided = set()
            for key in result:
                if key in source:
                    result[key] = cls._coerce_option_value(key, source[key])
                    provided.add(key)
                    if track_overrides and key in PENALTY_SUDDEN_DEATH_MAP.values():
                        override_sudden_death.add(key)

            if "allow_ten" in source:
                alias_value = cls._coerce_option_value("allow_ten_card", source["allow_ten"])
                ten_keys = ("allow_ten_card", "allow_ten_sum", "allow_ten_sandwich")
                for ten_key in ten_keys:
                    if ten_key not in provided:
                        result[ten_key] = alias_value

            if "penalty_mode" in source:
                legacy_penalty_mode = cls._normalize_penalty_mode(source["penalty_mode"])

        apply(base, False)
        apply(overrides, True)

        if legacy_penalty_mode is not None:
            is_sudden_death = legacy_penalty_mode == PENALTY_MODE_SUDDEN_DEATH
            for sudden_key in PENALTY_SUDDEN_DEATH_MAP.values():
                if sudden_key not in override_sudden_death:
                    result[sudden_key] = is_sudden_death

        result["bad_slap_penalty"] = cls._normalize_penalty_value(
            result.get("bad_slap_penalty"),
            cls.DEFAULT_OPTIONS["bad_slap_penalty"],
        )
        result["bad_play_penalty"] = cls._normalize_penalty_value(
            result.get("bad_play_penalty"),
            cls.DEFAULT_OPTIONS["bad_play_penalty"],
        )
        result["deck_mode"] = cls._normalize_deck_mode(result.get("deck_mode"))
        result["deck_count"] = cls._normalize_deck_count(result.get("deck_count"))
        
        timeout_val = result.get("eliminated_spam_timeout")
        result["eliminated_spam_timeout"] = timeout_val if timeout_val in (0, 10, 30, 60, -1) else cls.DEFAULT_OPTIONS["eliminated_spam_timeout"]
        return result

    @classmethod
    def normalize_legacy_options(cls, source):
        """Migre l'ancienne clé ``penalty_mode`` vers les drapeaux mort subite.

        Retourne ``(source_normalisée, converti?)``. Logique auparavant portée
        par le consommateur, désormais rattachée au jeu concerné.
        """
        if not isinstance(source, dict):
            return source, False
        updated = dict(source)
        if "penalty_mode" not in updated:
            return updated, False
        legacy_mode = cls._normalize_penalty_mode(updated.pop("penalty_mode"))
        is_sudden_death = legacy_mode == PENALTY_MODE_SUDDEN_DEATH
        for sudden_key in PENALTY_SUDDEN_DEATH_MAP.values():
            updated.setdefault(sudden_key, is_sudden_death)
        return updated, True

    @classmethod
    def options_cache_current(cls, cached):
        if not isinstance(cached, dict):
            return False
        if "penalty_mode" in cached:
            return False
        return set(PENALTY_SUDDEN_DEATH_MAP.values()).issubset(cached.keys())

    @classmethod
    def _normalize_penalty_mode(cls, value):
        if isinstance(value, str):
            lowered = value.strip().lower().replace("-", "_").replace(" ", "_")
            if lowered in {PENALTY_MODE_SUDDEN_DEATH, "suddendeath", "mort_subite"}:
                return PENALTY_MODE_SUDDEN_DEATH
        return PENALTY_MODE_FIXED

    @classmethod
    def _normalize_deck_mode(cls, value):
        if isinstance(value, str):
            lowered = value.strip().lower().replace("-", "_").replace(" ", "_")
        else:
            if isinstance(value, bool):
                return "manual" if value else "auto"
            lowered = str(value).strip().lower().replace("-", "_").replace(" ", "_") if value is not None else None
        if not lowered:
            return cls.DEFAULT_OPTIONS["deck_mode"]
        if lowered in {"manual", "manuelle", "manuel"}:
            return "manual"
        if lowered in {"auto", "automatic", "automatique", "auto_mode"}:
            return "auto"
        return cls.DEFAULT_OPTIONS["deck_mode"]

    @classmethod
    def _normalize_deck_count(cls, value):
        default = cls.DEFAULT_OPTIONS["deck_count"]
        try:
            numeric = int(value)
        except (TypeError, ValueError):
            numeric = default
        if numeric < 1:
            numeric = 1
        if numeric > 3:
            numeric = 3
        return numeric

    @classmethod
    def _normalize_penalty_value(cls, value, default):
        min_step = min(PENALTY_STEPS)
        max_step = max(PENALTY_STEPS)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"off", "none", "no", "false", "disable", "disabled"}:
                return min_step
            try:
                numeric = int(lowered)
            except ValueError:
                numeric = None
        elif isinstance(value, (int, float)):
            numeric = int(value)
        else:
            try:
                numeric = int(value)
            except (TypeError, ValueError):
                numeric = None
        try:
            fallback = int(default)
        except (TypeError, ValueError):
            fallback = min_step
        fallback = max(min_step, min(max_step, fallback))
        if numeric is None:
            numeric = fallback
        numeric = max(min_step, min(max_step, numeric))
        return numeric

    def __init__(self, players, options=None):
        self.players = players[:]
        self.n = len(players)
        self.hands = {pid: deque() for pid in players}
        self.center = []
        self.penalties = []
        self.turn_idx = random.randrange(self.n)
        self.face_chances = 0
        self.waiting_for_face_from = None
        self.pending_collect = False
        self.collect_winner = None
        self.winner = None
        self.last_face_player = None
        self.options = self.sanitize_options(base=options)
        self.eliminated_invalid_slaps = {pid: 0 for pid in players}
        self.timeout_until = {pid: 0 for pid in players}
        self._deal()

    def set_options(self, options):
        self.options = self.sanitize_options(base=options)
        return self.options

    def update_options(self, overrides):
        self.options = self.sanitize_options(overrides=overrides, base=self.options)
        return self.options

    def serialize(self, mask_for=None):
        counts = {str(pid): len(self.hands[pid]) for pid in self.players}  # <-- clés en str
        active_players = [
            pid for pid in self.players
            if self.hands[pid] or (self.pending_collect and pid == self.collect_winner)
        ]
        return {
            "players": self.players,              # ok (liste d’int)
            "counts": counts,                     # fix
            "center_count": len(self.center),
            "top_center": self.center[-1] if self.center else None,
            "last_four_center": self.center[-4:],
            "penalty_count": len(self.penalties),
            "turn": self.players[self.turn_idx],  # ok (valeur int)
            "face_chances": self.face_chances,
            "waiting_for_face_from": self.waiting_for_face_from,
            "pending_collect": self.pending_collect,
            "collect_winner": self.collect_winner,
            "winner": self.winner,
            "active_players": active_players,
            "options": dict(self.options),
            "timeout_until": self.timeout_until,
            "eliminated_invalid_slaps": self.eliminated_invalid_slaps,
        }

    def _resolve_deck_count(self):
        mode = self._normalize_deck_mode(self.options.get("deck_mode"))
        if mode == "manual":
            return self._normalize_deck_count(self.options.get("deck_count"))
        if self.n <= 0:
            return self.DEFAULT_OPTIONS["deck_count"]
        decks = 1 + max(0, (self.n - 1) // 4)
        return min(3, max(1, decks))

    def _deal(self):
        deck_count = self._resolve_deck_count()
        deck = []
        for _ in range(deck_count):
            deck.extend(new_deck())
        random.shuffle(deck)
        for i, card in enumerate(deck):
            self.hands[self.players[i % self.n]].append(card)

    def _is_face(self, card):
        return card[0] in FACE_PENALTIES

    def _slap_valid(self):
        if len(self.center) == 0:
            return False

        a = self.center[-1][0]

        if self.options["allow_ten_card"] and a == "T":
            return True

        if len(self.center) == 1:
            return False

        b = self.center[-2][0]
        if self.options["allow_double"] and a == b:
            return True

        has_three = len(self.center) >= 3
        if self.options["allow_sandwich"] and has_three:
            c = self.center[-3][0]
            if a == c:
                return True

        if self.options["allow_runs"] and has_three:
            vals = [RANK_VALUE[self.center[-i][0]] for i in (1,2,3)]
            # FIX: Check for both descending AND ascending runs
            if (vals[0] == vals[1]+1 == vals[2]+2) or (vals[0] == vals[1]-1 == vals[2]-2):
                return True

        v1, v2 = RANK_VALUE[a], RANK_VALUE[b]
        if self.options["allow_ten_sum"] and (v1 + v2) == 10:
            return True

        if has_three and self.options["allow_ten_sandwich"]:
            c = self.center[-3][0]
            if (v1 + RANK_VALUE[c]) == 10:
                return True
        return False

    def is_timed_out(self, player_id):
        import time
        t = self.timeout_until.get(player_id, 0)
        if t == -1:
            return True
        return t > time.time()

    def play_card(self, player_id):
        if self.is_timed_out(player_id):
            return {"error": "timeout"}

        if self.pending_collect and player_id == self.collect_winner:
            self.turn_idx = self.players.index(player_id)
            self._collect_center(player_id)
            # The person who collects the cards starts the next round.
            # We do NOT advance the turn here.
            self._advance_turn()
            return {"ok": True, "collected": True}

        if self.players[self.turn_idx] != player_id:
            taken = self._apply_penalty(player_id, "bad_play_penalty")
            return {"error": "not-your-turn", "penalized": len(taken)}

        if not self.hands[player_id]:
            return {"error":"no-cards"}

        card = self.hands[player_id].popleft()
        self.center.append(card)

        if self._is_face(card):
            self.face_chances = FACE_PENALTIES[card[0]]
            self.last_face_player = player_id

            next_idx = self._next_active_idx(self.players.index(player_id))
            if next_idx is not None:
                self.waiting_for_face_from = self.players[next_idx]
                self.turn_idx = next_idx
            else:
                self.waiting_for_face_from = None
                self._resolve_face_failure(self.last_face_player)
        else:
            if self.face_chances > 0:
                self.face_chances -= 1
                if self.face_chances == 0:
                    winner = self.last_face_player or self._prev_player()
                    self._resolve_face_failure(winner)
            else:
                # FIX: It's a normal card play without a contest!
                # We strictly pass the turn to the next player.
                self.waiting_for_face_from = None
                self.last_face_player = None
                next_idx = self._next_active_idx(self.turn_idx)
                if next_idx is not None:
                    self.turn_idx = next_idx

        self._advance_turn()
        return {"ok": True, "card": card}

    def slap(self, player_id):
        if self.is_timed_out(player_id):
            return {"ok": False, "error": "timeout", "valid": False}

        if self._slap_valid():
            self.face_chances = 0
            self.waiting_for_face_from = None
            self.turn_idx = self.players.index(player_id)
            self._collect_center(player_id)
            self.eliminated_invalid_slaps[player_id] = 0
            return {"ok": True, "valid": True}
        else:
            taken = self._apply_penalty(player_id, "bad_slap_penalty")
            
            # Spam detection for eliminated players
            if not self.hands[player_id]:
                self.eliminated_invalid_slaps[player_id] += 1
                if self.eliminated_invalid_slaps[player_id] >= 3:
                    import time
                    timeout_opt = self.options.get("eliminated_spam_timeout", 0)
                    if timeout_opt > 0:
                        self.timeout_until[player_id] = time.time() + timeout_opt
                    elif timeout_opt == -1:
                        self.timeout_until[player_id] = -1
                    self.eliminated_invalid_slaps[player_id] = 0

            return {"ok": True, "valid": False, "penalized": len(taken)}

    def _apply_penalty(self, player_id, key):
        taken = []
        sudden_key = PENALTY_SUDDEN_DEATH_MAP.get(key)
        sudden_death_enabled = bool(sudden_key and self.options.get(sudden_key))
        if sudden_death_enabled:
            while self.hands[player_id]:
                taken.append(self.hands[player_id].popleft())
        else:
            raw_count = self.options.get(key, 0)
            try:
                count = max(0, int(raw_count))
            except (TypeError, ValueError):
                count = 0
            for _ in range(count):
                if self.hands[player_id]:
                    taken.append(self.hands[player_id].popleft())
        if taken:
            self.penalties.extend(taken)
        return taken

    def _collect_center(self, player_id):
        random.shuffle(self.center)
        self.hands[player_id].extend(self.center)
        if self.penalties:
            self.hands[player_id].extend(self.penalties)
        self.center = []
        self.penalties = []
        self.pending_collect = False
        self.collect_winner = None
        self.last_face_player = None
        self.turn_idx = self.players.index(player_id)
        self._advance_turn()

    def _next_player(self):
        return self.players[(self.turn_idx+1) % self.n]

    def _prev_player(self):
        return self.players[(self.turn_idx-1) % self.n]

    def _active_players(self):
        return [pid for pid in self.players if self.hands[pid]]

    def _next_active_idx(self, idx):
        for _ in range(self.n):
            idx = (idx + 1) % self.n
            if self.hands[self.players[idx]]:
                return idx
        return None

    def _prev_active_idx(self, idx):
        for _ in range(self.n):
            idx = (idx - 1) % self.n
            if self.hands[self.players[idx]]:
                return idx
        return None

    def _resolve_face_failure(self, winner):
        if winner is not None:
            self.pending_collect = True
            self.collect_winner = winner
            self.turn_idx = self.players.index(winner)
        self.waiting_for_face_from = None
        self.face_chances = 0
        self.last_face_player = None

    def _advance_turn(self):
        active_players = self._active_players()
        if len(active_players) == 1 and self.face_chances == 0:
            self.winner = active_players[0]
            self.turn_idx = self.players.index(self.winner)
            return
        else:
            self.winner = None

        if self.face_chances > 0 and self.waiting_for_face_from is not None:
            self.turn_idx = self.players.index(self.waiting_for_face_from)
            return

        if self.pending_collect and self.collect_winner is not None:
            self.turn_idx = self.players.index(self.collect_winner)
            return

        # Ensure the current player has cards. If they are empty, skip them.
        current_player = self.players[self.turn_idx]
        if not self.hands[current_player]:
            next_idx = self._next_active_idx(self.turn_idx)
            if next_idx is not None:
                self.turn_idx = next_idx

    # Added for arbitration
    def is_slap_valid(self):
        return self._slap_valid()

    def resolve_slap(self, winner_id):
        self.face_chances = 0
        self.waiting_for_face_from = None
        self.turn_idx = self.players.index(winner_id)
        self._collect_center(winner_id)
        self._advance_turn()
