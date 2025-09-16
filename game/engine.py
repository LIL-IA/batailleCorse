import random
from collections import deque

RANKS = "23456789TJQKA"
RANK_VALUE = {r:i for i,r in enumerate(RANKS, start=2)}
FACE_PENALTIES = {"J":1, "Q":2, "K":3, "A":4}

def new_deck():
    suits = "CDHS"
    deck = [r+s for r in RANKS for s in suits]
    random.shuffle(deck)
    return deck

class GameEngine:
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
        self.options = {
            "allow_sandwich": True,
            "allow_double": True,
            "allow_runs": False,
            "allow_ten": True,
            "bad_slap_penalty": 2,
            "bad_play_penalty": 2,
        }
        if options:
            self.options.update(options)
        self._deal()

    def serialize(self, mask_for=None):
        counts = {str(pid): len(self.hands[pid]) for pid in self.players}  # <-- clés en str
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
        }

    def _deal(self):
        deck = new_deck()
        for i, card in enumerate(deck):
            self.hands[self.players[i % self.n]].append(card)

    def _is_face(self, card):
        return card[0] in FACE_PENALTIES

    def _slap_valid(self):
        if len(self.center) == 0:
            return False

        a = self.center[-1][0]

        if self.options["allow_ten"] and a == "T":
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
            if vals[0] == vals[1]+1 == vals[2]+2:
                return True
        if self.options["allow_ten"]:
            v1, v2 = RANK_VALUE[a], RANK_VALUE[b]
            if (v1 + v2) == 10:
                return True
            if has_three:
                c = self.center[-3][0]
                if (v1 + RANK_VALUE[c]) == 10:
                    return True
        return False

    def play_card(self, player_id):
        if self.pending_collect and player_id == self.collect_winner:
            self._collect_center(player_id)
            self.pending_collect = False
            self.collect_winner = None
            self.turn_idx = self.players.index(player_id)
            return {"ok": True, "collected": True}
        if self.players[self.turn_idx] != player_id:
            pen = self.options.get("bad_play_penalty", 0)
            taken = []
            for _ in range(pen):
                if self.hands[player_id]:
                    taken.append(self.hands[player_id].popleft())
            if taken:
                self.penalties.extend(taken)
            return {"error": "not-your-turn", "penalized": len(taken)}
        if not self.hands[player_id]:
            return {"error":"no-cards"}

        card = self.hands[player_id].popleft()
        self.center.append(card)

        if self._is_face(card):
            self.face_chances = FACE_PENALTIES[card[0]]
            self.waiting_for_face_from = self._next_player()
            self.turn_idx = self.players.index(self.waiting_for_face_from)
        else:
            if self.face_chances > 0:
                self.face_chances -= 1
                if self.face_chances == 0:
                    winner = self._prev_player()
                    self.pending_collect = True
                    self.collect_winner = winner
                    self.turn_idx = self.players.index(winner)
                    self.waiting_for_face_from = None
            else:
                self.turn_idx = self.players.index(self._next_player())
        return {"ok": True, "card": card}

    def slap(self, player_id):
        if self._slap_valid():
            self._collect_center(player_id)
            self.turn_idx = self.players.index(player_id)
            self.face_chances = 0
            self.waiting_for_face_from = None
            return {"ok": True, "valid": True}
        else:
            pen = self.options["bad_slap_penalty"]
            taken = []
            for _ in range(pen):
                if self.hands[player_id]:
                    taken.append(self.hands[player_id].popleft())
            self.penalties.extend(taken)
            return {"ok": True, "valid": False, "penalized": len(taken)}

    def _collect_center(self, player_id):
        random.shuffle(self.center)
        self.hands[player_id].extend(self.center)
        if self.penalties:
            self.hands[player_id].extend(self.penalties)
        self.center = []
        self.penalties = []
        self.pending_collect = False
        self.collect_winner = None

    def _next_player(self):
        return self.players[(self.turn_idx+1) % self.n]

    def _prev_player(self):
        return self.players[(self.turn_idx-1) % self.n]

    # Added for arbitration
    def is_slap_valid(self):
        return self._slap_valid()

    def resolve_slap(self, winner_id):
        self._collect_center(winner_id)
        self.turn_idx = self.players.index(winner_id)
        self.face_chances = 0
        self.waiting_for_face_from = None
