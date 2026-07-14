"""Moteur du jeu « Le 1% » — jeu de bluff, d'enchères et de dés.

Boucle complète d'un tour global :

1. ``bidding`` : les joueurs encore en lice enchérissent tour à tour sur la
   somme totale d'une catégorie présente dans les mains. Chaque annonce doit
   surenchérir (valeur strictement supérieure) ou le joueur peut douter.
2. ``voting`` : un doute déclenche un vote des autres joueurs (accusé vs
   accusateur). À deux joueurs, pas de vote : résolution directe.
3. Révélation : on somme réellement la catégorie visée. Somme ≥ enchère →
   l'accusé (dernier enchérisseur) gagne ; sinon l'accusateur gagne. Le perdant
   du duel et les votants qui se sont trompés sont éliminés pour le tour ; toutes
   les mains partent à la défausse (pas de remélange en cours de tour).
4. Tant qu'il reste >1 survivant : nouveau duel, mains redistribuées depuis le
   reste de la pioche. À 1 survivant : phase ``reward``.
5. ``reward`` : le survivant dispose de 3 actions (prendre une carte au centre,
   lancer les dés). Les bonus détenus (relance/pioche/vol) sont activables
   gratuitement. Une combinaison de dés gagnante (0 + numéros récompense) fait
   gagner la partie. Sinon on rassemble la défausse, on mélange, on complète le
   centre et un nouveau tour global démarre.
"""

import random

from ..base import BaseGameEngine
from .cards import (
    BASE_WINNING_NUMBER,
    CATEGORY_KEYS,
    D10_FACES,
    build_draw_pile,
    build_reward_bonus_pile,
)

VOTE_ACCUSED = "accused"  # « le dernier enchérisseur dit vrai »
VOTE_ACCUSER = "accuser"  # « c'est un bluff »


class UnPourCentEngine(BaseGameEngine):
    DEFAULT_OPTIONS = {
        "starting_hand_size": 4,
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

        # État persistant (d'un tour à l'autre).
        self.winner = None
        self.reward_numbers = {pid: [] for pid in self.players}
        self.bonuses = {pid: [] for pid in self.players}

        # Paquets (les cartes de catégorie tournent pioche <-> mains <-> défausse ;
        # le paquet du centre — récompenses + bonus — ne fait que diminuer).
        self.draw_pile = build_draw_pile()
        random.shuffle(self.draw_pile)
        self.center_pile = build_reward_bonus_pile()
        random.shuffle(self.center_pile)
        self.discard = []
        self.center = []
        self.hands = {pid: [] for pid in self.players}

        # État transitoire d'un tour.
        self.in_round = []
        self.eliminated = []
        self.turn_idx = 0
        self.phase = "bidding"
        self.current_bid = None
        self.doubt = None
        self.votes = {}
        self.reward_player = None
        self.reward_actions_left = 0
        self.last_roll = None
        self.last_reveal = None
        self._turn_counter = 0

        self._start_turn(first=True)

    # =================================================================== setup
    def _refill_center(self):
        slots = self.options["center_slots"]
        while len(self.center) < slots and self.center_pile:
            self.center.append(self.center_pile.pop())

    def _deal_to(self, player_ids):
        size = self.options["starting_hand_size"]
        for pid in player_ids:
            hand = []
            for _ in range(size):
                if not self.draw_pile:
                    break
                hand.append(self.draw_pile.pop())
            self.hands[pid] = hand

    def _start_turn(self, first=False):
        """Nouveau tour global : tout le monde rejoue."""
        self.in_round = list(self.players)
        self.eliminated = []
        self.current_bid = None
        self.doubt = None
        self.votes = {}
        self.reward_player = None
        self.reward_actions_left = 0
        self.last_roll = None
        self.phase = "bidding"
        self._refill_center()
        self._deal_to(self.in_round)
        if self.n:
            self.turn_idx = self._turn_counter % self.n
        else:
            self.turn_idx = 0

    def _start_duel(self, first_bidder):
        """Nouveau duel dans le même tour : les survivants redistribuent."""
        self.current_bid = None
        self.doubt = None
        self.votes = {}
        self.phase = "bidding"
        self._deal_to(self.in_round)
        if first_bidder in self.in_round:
            self.turn_idx = self.in_round.index(first_bidder)
        else:
            self.turn_idx = 0

    def _end_turn(self):
        """Fin de tour : on rassemble la défausse dans la pioche et on relance."""
        self.draw_pile.extend(self.discard)
        self.discard = []
        # Sécurité : toute main résiduelle repart aussi dans la pioche.
        for pid in self.players:
            if self.hands[pid]:
                self.draw_pile.extend(self.hands[pid])
                self.hands[pid] = []
        random.shuffle(self.draw_pile)
        self._turn_counter += 1
        self._start_turn()

    # ================================================================= helpers
    def _current_player(self):
        if self.phase == "bidding" and self.in_round:
            return self.in_round[self.turn_idx % len(self.in_round)]
        if self.phase == "reward":
            return self.reward_player
        return None

    def _advance_bid_turn(self):
        if self.in_round:
            self.turn_idx = (self.turn_idx + 1) % len(self.in_round)

    def _voters(self):
        if not self.doubt:
            return []
        excluded = {self.doubt["accuser"], self.doubt["accused"]}
        return [pid for pid in self.in_round if pid not in excluded]

    def category_sum(self, category, players=None):
        players = self.in_round if players is None else players
        total = 0
        for pid in players:
            for card in self.hands[pid]:
                if card.get("category") == category:
                    total += card.get("value", 0)
        return total

    def winning_numbers(self, player_id):
        numbers = [BASE_WINNING_NUMBER]
        numbers.extend(self.reward_numbers.get(player_id, []))
        return sorted(set(numbers))

    def win_probability_percent(self, player_id):
        k = len(self.winning_numbers(player_id))
        return round((k / len(D10_FACES)) ** 2 * 100, 2)

    # =========================================================== sérialisation
    def serialize(self, mask_for=None):
        state = {
            "game": "1_percent",
            "players": list(self.players),
            "in_round": list(self.in_round),
            "eliminated": list(self.eliminated),
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
            "current_bid": dict(self.current_bid) if self.current_bid else None,
            "doubt": dict(self.doubt) if self.doubt else None,
            "voters": self._voters() if self.phase == "voting" else [],
            "voted": list(self.votes.keys()) if self.phase == "voting" else [],
            "votes_count": len(self.votes),
            "reward_player": self.reward_player,
            "reward_actions_left": self.reward_actions_left,
            "last_roll": dict(self.last_roll) if self.last_roll else None,
            "last_reveal": self.last_reveal,
            "categories": list(CATEGORY_KEYS),
            "draw_count": len(self.draw_pile),
            "center_pile_count": len(self.center_pile),
            "discard_count": len(self.discard),
            "winner": self.winner,
            "options": dict(self.options),
        }
        # Information cachée : seule la main du destinataire est révélée.
        if mask_for is not None and mask_for in self.hands:
            state["hand"] = [dict(card) for card in self.hands[mask_for]]
            state["hand_owner"] = mask_for
        return state

    # ================================================================= actions
    def handle_action(self, user_id, content):
        if self.winner is not None:
            return {"error": "game-over"}
        action = content.get("action")
        if action == "bid":
            return self._bid(user_id, content.get("category"), content.get("value"))
        if action == "doubt":
            return self._doubt(user_id)
        if action == "vote":
            return self._vote(user_id, content.get("choice"))
        if action in ("take_center", "take_reward", "take_bonus"):
            return self._take_center(user_id, content.get("index"))
        if action == "roll":
            return self._roll(user_id)
        if action == "use_bonus":
            return self._use_bonus(user_id, content)
        if action == "end_reward":
            return self._end_reward(user_id)
        return {"error": "unknown-action"}

    # --- phase enchères -----------------------------------------------------
    def _bid(self, user_id, category, value):
        if self.phase != "bidding":
            return {"error": "bad-phase"}
        if self._current_player() != user_id:
            return {"error": "not-your-turn"}
        if category not in CATEGORY_KEYS:
            return {"error": "invalid-category"}
        try:
            value = int(value)
        except (TypeError, ValueError):
            return {"error": "invalid-bid"}
        minimum = (self.current_bid["value"] if self.current_bid else 0) + 1
        if value < minimum:
            return {"error": "bid-too-low", "min": minimum}
        self.current_bid = {"player": user_id, "category": category, "value": value}
        self._advance_bid_turn()
        return {"ok": True, "bid": dict(self.current_bid)}

    def _doubt(self, user_id):
        if self.phase != "bidding":
            return {"error": "bad-phase"}
        if self._current_player() != user_id:
            return {"error": "not-your-turn"}
        if self.current_bid is None:
            return {"error": "nothing-to-doubt"}
        self.doubt = {
            "accuser": user_id,
            "accused": self.current_bid["player"],
        }
        self.votes = {}
        voters = self._voters()
        if not voters:
            return self._resolve()
        self.phase = "voting"
        return {"ok": True, "doubt": dict(self.doubt), "voters": voters}

    # --- phase vote ---------------------------------------------------------
    def _vote(self, user_id, choice):
        if self.phase != "voting":
            return {"error": "bad-phase"}
        if user_id not in self._voters():
            return {"error": "not-a-voter"}
        if user_id in self.votes:
            return {"error": "already-voted"}
        if choice not in (VOTE_ACCUSED, VOTE_ACCUSER):
            return {"error": "invalid-vote"}
        self.votes[user_id] = choice
        if len(self.votes) >= len(self._voters()):
            return self._resolve()
        return {
            "ok": True,
            "votes_count": len(self.votes),
            "voters_total": len(self._voters()),
        }

    # --- révélation ---------------------------------------------------------
    def _resolve(self):
        bid = self.current_bid
        doubt = self.doubt
        category = bid["category"]
        target = bid["value"]
        accused = doubt["accused"]
        accuser = doubt["accuser"]

        actual = self.category_sum(category)
        accused_truthful = actual >= target
        duel_winner = accused if accused_truthful else accuser
        duel_loser = accuser if accused_truthful else accused

        correct_choice = VOTE_ACCUSED if accused_truthful else VOTE_ACCUSER
        wrong_voters = [v for v, c in self.votes.items() if c != correct_choice]

        eliminated_now = set(wrong_voters)
        eliminated_now.add(duel_loser)

        contributions = {
            str(pid): self.category_sum(category, players=[pid])
            for pid in self.in_round
        }

        self.last_reveal = {
            "category": category,
            "bid": target,
            "actual": actual,
            "accused": accused,
            "accuser": accuser,
            "accused_truthful": accused_truthful,
            "duel_winner": duel_winner,
            "duel_loser": duel_loser,
            "wrong_voters": list(wrong_voters),
            "votes": dict(self.votes),
            "contributions": contributions,
            "eliminated": sorted(eliminated_now),
        }

        # Toutes les mains du tour partent à la défausse.
        for pid in self.in_round:
            self.discard.extend(self.hands[pid])
            self.hands[pid] = []

        survivors = [pid for pid in self.in_round if pid not in eliminated_now]
        self.eliminated.extend(pid for pid in self.in_round if pid in eliminated_now)
        self.in_round = survivors
        self.current_bid = None
        self.doubt = None
        self.votes = {}

        result = {"ok": True, "reveal": dict(self.last_reveal)}
        if len(survivors) > 1:
            self._start_duel(first_bidder=duel_winner)
            result["next"] = "duel"
        else:
            # Un seul survivant : phase récompense.
            self.reward_player = survivors[0] if survivors else duel_winner
            self.reward_actions_left = self.options["reward_actions"]
            self.phase = "reward"
            result["next"] = "reward"
            result["reward_player"] = self.reward_player
        return result

    # --- phase récompense ---------------------------------------------------
    def _take_center(self, user_id, index):
        if self.phase != "reward":
            return {"error": "bad-phase"}
        if user_id != self.reward_player:
            return {"error": "not-your-turn"}
        if self.reward_actions_left <= 0:
            return {"error": "no-actions-left"}
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
        self.reward_actions_left -= 1
        self._refill_center()
        self._maybe_end_reward()
        return {"ok": True, "card": card, "actions_left": self.reward_actions_left}

    def _roll(self, user_id):
        if self.phase != "reward":
            return {"error": "bad-phase"}
        if user_id != self.reward_player:
            return {"error": "not-your-turn"}
        if self.reward_actions_left <= 0:
            return {"error": "no-actions-left"}
        dice = [random.choice(D10_FACES), random.choice(D10_FACES)]
        winning = set(self.winning_numbers(user_id))
        win = all(d in winning for d in dice)
        self.reward_actions_left -= 1
        self.last_roll = {
            "player": user_id,
            "dice": dice,
            "win": win,
            "can_reroll": not win,
        }
        if win:
            self.winner = user_id
            self.phase = "game_over"
            return {"ok": True, "dice": dice, "win": True}
        self._maybe_end_reward()
        return {"ok": True, "dice": dice, "win": False, "actions_left": self.reward_actions_left}

    def _use_bonus(self, user_id, content):
        if self.phase != "reward" or user_id != self.reward_player:
            return {"error": "bad-phase"}
        power = content.get("power")
        held = self.bonuses.get(user_id, [])
        if power not in held:
            return {"error": "no-such-bonus"}

        if power == "reroll":
            roll = self.last_roll
            if not roll or roll.get("player") != user_id or roll.get("win"):
                return {"error": "cannot-reroll"}
            try:
                die = int(content.get("die", 0))
            except (TypeError, ValueError):
                return {"error": "invalid-die"}
            if die not in (0, 1):
                return {"error": "invalid-die"}
            roll["dice"][die] = random.choice(D10_FACES)
            winning = set(self.winning_numbers(user_id))
            win = all(d in winning for d in roll["dice"])
            roll["win"] = win
            roll["can_reroll"] = False
            roll["rerolled"] = True
            held.remove("reroll")
            if win:
                self.winner = user_id
                self.phase = "game_over"
                return {"ok": True, "power": "reroll", "dice": list(roll["dice"]), "win": True}
            self._maybe_end_reward()
            return {"ok": True, "power": "reroll", "dice": list(roll["dice"]), "win": False}

        if power == "draw2":
            drawn = []
            for _ in range(2):
                if not self.center_pile:
                    break
                card = self.center_pile.pop()
                drawn.append(card)
                if card.get("kind") == "reward":
                    self.reward_numbers.setdefault(user_id, []).append(card["value"])
                else:
                    self.bonuses.setdefault(user_id, []).append(card["power"])
            held.remove("draw2")
            self._maybe_end_reward()
            return {"ok": True, "power": "draw2", "drawn": drawn}

        if power == "steal":
            try:
                target = int(content.get("target"))
            except (TypeError, ValueError):
                return {"error": "invalid-target"}
            if target == user_id or target not in self.players:
                return {"error": "invalid-target"}
            stolen = None
            requested = content.get("value")
            target_rewards = self.reward_numbers.get(target, [])
            if target_rewards:
                if requested is not None:
                    try:
                        requested = int(requested)
                    except (TypeError, ValueError):
                        requested = None
                if requested in target_rewards:
                    target_rewards.remove(requested)
                    value = requested
                else:
                    value = target_rewards.pop()
                self.reward_numbers.setdefault(user_id, []).append(value)
                stolen = {"kind": "reward", "value": value}
            elif self.bonuses.get(target):
                power_stolen = self.bonuses[target].pop()
                self.bonuses.setdefault(user_id, []).append(power_stolen)
                stolen = {"kind": "bonus", "power": power_stolen}
            else:
                return {"error": "nothing-to-steal"}
            held.remove("steal")
            self._maybe_end_reward()
            return {"ok": True, "power": "steal", "from": target, "stolen": stolen}

        return {"error": "unknown-bonus"}

    def _end_reward(self, user_id):
        if self.phase != "reward" or user_id != self.reward_player:
            return {"error": "bad-phase"}
        self._end_turn()
        return {"ok": True, "next": "turn"}

    def _maybe_end_reward(self):
        """Fin auto de la phase récompense quand il ne reste rien à faire.

        On n'enchaîne pas immédiatement si le joueur détient encore un bonus :
        il peut vouloir l'activer (ex. relancer un dé après son dernier lancer).
        """
        if self.phase != "reward" or self.winner is not None:
            return
        if self.reward_actions_left <= 0 and not self.bonuses.get(self.reward_player):
            self._end_turn()
