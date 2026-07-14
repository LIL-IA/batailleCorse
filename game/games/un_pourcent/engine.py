"""Moteur du jeu « Le 1% » — squelette jouable.

Ce qui est implémenté (noyau jouable) :
  * distribution des mains depuis la pioche (cartes de catégorie) ;
  * 3 cartes Récompense/Bonus retournées au centre, réappovisionnées ;
  * zone de récompenses par joueur (numéros débloqués) + bonus détenus ;
  * action « prendre une carte au centre » ;
  * action « tenter sa chance » : lancer de 2 dés à 10 faces, victoire si les
    deux résultats font partie des numéros gagnants du joueur (0 + récompenses).

Ce qui reste à faire (itération suivante) : phase d'enchères, doute, vote,
élimination, gestion fine des tours et des 3 actions de récompense, pouvoirs des
bonus. Ces actions renvoient pour l'instant une erreur ``phase-not-implemented``.
"""

import random

from ..base import BaseGameEngine
from .cards import (
    BASE_WINNING_NUMBER,
    D10_FACES,
    build_draw_pile,
    build_reward_bonus_pile,
)


class UnPourCentEngine(BaseGameEngine):
    DEFAULT_OPTIONS = {
        "starting_hand_size": 5,
        "center_slots": 3,
        "reward_actions": 3,
    }

    @classmethod
    def sanitize_options(cls, overrides=None, base=None):
        result = cls.default_options()
        for source in (base, overrides):
            if isinstance(source, dict):
                for key in result:
                    if key in source:
                        try:
                            result[key] = max(1, int(source[key]))
                        except (TypeError, ValueError):
                            pass
        return result

    def __init__(self, players, options=None):
        self.players = list(players)
        self.n = len(self.players)
        self.options = self.sanitize_options(base=options)
        self.turn_idx = random.randrange(self.n) if self.n else 0
        self.winner = None
        self.last_roll = None
        self.phase = "reward"  # squelette : on démarre en phase récompense/dés

        # Zones de jeu personnelles (persistent d'un tour à l'autre).
        self.reward_numbers = {pid: [] for pid in self.players}
        self.bonuses = {pid: [] for pid in self.players}

        # Paquets.
        self.draw_pile = build_draw_pile()
        random.shuffle(self.draw_pile)
        self.center_pile = build_reward_bonus_pile()
        random.shuffle(self.center_pile)
        self.discard = []
        self.hands = {pid: [] for pid in self.players}
        self.center = []

        self._deal_hands()
        self._refill_center()

    # ------------------------------------------------------------------ setup
    def _deal_hands(self):
        size = self.options["starting_hand_size"]
        for pid in self.players:
            hand = []
            for _ in range(size):
                if not self.draw_pile:
                    break
                hand.append(self.draw_pile.pop())
            self.hands[pid] = hand

    def _refill_center(self):
        slots = self.options["center_slots"]
        while len(self.center) < slots and self.center_pile:
            self.center.append(self.center_pile.pop())

    # -------------------------------------------------------------- helpers
    def winning_numbers(self, player_id):
        """Numéros gagnants d'un joueur : le « 0 » de base + ses récompenses."""
        numbers = [BASE_WINNING_NUMBER]
        numbers.extend(self.reward_numbers.get(player_id, []))
        # Uniques et ordonnés pour un affichage stable.
        return sorted(set(numbers))

    def win_probability_percent(self, player_id):
        """Probabilité (%) de gagner à un lancer : (k/10)² avec k numéros."""
        k = len(self.winning_numbers(player_id))
        return round((k / len(D10_FACES)) ** 2 * 100, 2)

    def _current_player(self):
        return self.players[self.turn_idx] if self.n else None

    # ------------------------------------------------------------- sérialisation
    def serialize(self, mask_for=None):
        return {
            "game": "1_percent",
            "players": list(self.players),
            "counts": {str(pid): len(self.hands[pid]) for pid in self.players},
            "center": [dict(card) for card in self.center],
            "reward_numbers": {
                str(pid): list(self.reward_numbers[pid]) for pid in self.players
            },
            "bonuses": {str(pid): list(self.bonuses[pid]) for pid in self.players},
            "winning_numbers": {
                str(pid): self.winning_numbers(pid) for pid in self.players
            },
            "win_probability": {
                str(pid): self.win_probability_percent(pid) for pid in self.players
            },
            "turn": self._current_player(),
            "phase": self.phase,
            "last_roll": self.last_roll,
            "draw_count": len(self.draw_pile),
            "center_pile_count": len(self.center_pile),
            "discard_count": len(self.discard),
            "winner": self.winner,
            "options": dict(self.options),
        }

    # ------------------------------------------------------------------ actions
    def handle_action(self, user_id, content):
        if self.winner is not None:
            return {"error": "game-over"}
        action = content.get("action")
        if action == "roll":
            return self._roll(user_id)
        if action == "take_center":
            return self._take_center(user_id, content.get("index"))
        if action in {"bid", "raise", "doubt", "vote"}:
            # Phases de bluff à venir.
            return {"error": "phase-not-implemented"}
        return {"error": "unknown-action"}

    def _roll(self, user_id):
        d1 = random.choice(D10_FACES)
        d2 = random.choice(D10_FACES)
        winning = set(self.winning_numbers(user_id))
        win = d1 in winning and d2 in winning
        self.last_roll = {"player": user_id, "dice": [d1, d2], "win": win}
        if win:
            self.winner = user_id
        return {"ok": True, "dice": [d1, d2], "win": win}

    def _take_center(self, user_id, index):
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return {"error": "invalid-index"}
        if idx < 0 or idx >= len(self.center):
            return {"error": "invalid-index"}
        card = self.center.pop(idx)
        if card.get("kind") == "reward":
            self.reward_numbers.setdefault(user_id, []).append(card["value"])
        elif card.get("kind") == "bonus":
            self.bonuses.setdefault(user_id, []).append(card["power"])
        self._refill_center()
        return {"ok": True, "card": card}
