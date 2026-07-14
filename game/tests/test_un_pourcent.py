from unittest.mock import patch

from django.test import SimpleTestCase

from game.games.un_pourcent.engine import UnPourCentEngine


def draw(category, value):
    return {"kind": "draw", "category": category, "value": value}


class UnPourCentEngineTests(SimpleTestCase):
    def test_initial_setup(self):
        engine = UnPourCentEngine([1, 2, 3])
        self.assertEqual(engine.phase, "bidding")
        self.assertEqual(set(engine.in_round), {1, 2, 3})
        self.assertEqual(len(engine.center), engine.options["center_slots"])
        for pid in (1, 2, 3):
            self.assertEqual(len(engine.hands[pid]), engine.options["starting_hand_size"])

    def test_serialize_masks_other_hands(self):
        engine = UnPourCentEngine([1, 2])
        state_for_1 = engine.serialize(mask_for=1)
        self.assertIn("hand", state_for_1)
        self.assertEqual(state_for_1["hand_owner"], 1)
        self.assertEqual(len(state_for_1["hand"]), len(engine.hands[1]))
        # Aucune main d'adversaire n'est exposée, seulement les tailles.
        self.assertNotIn(2, [state_for_1.get("hand_owner")])
        state_no_mask = engine.serialize()
        self.assertNotIn("hand", state_no_mask)
        self.assertIn("1", state_no_mask["counts"])

    def test_bid_requires_turn_and_valid_category(self):
        engine = UnPourCentEngine([1, 2])
        engine.in_round = [1, 2]
        engine.turn_idx = 0
        engine.current_bid = None
        engine.phase = "bidding"

        self.assertEqual(
            engine.handle_action(2, {"action": "bid", "category": "shark", "value": 3}),
            {"error": "not-your-turn"},
        )
        self.assertEqual(
            engine.handle_action(1, {"action": "bid", "category": "nope", "value": 3})["error"],
            "invalid-category",
        )
        res = engine.handle_action(1, {"action": "bid", "category": "shark", "value": 3})
        self.assertTrue(res["ok"])
        # La surenchère doit être strictement supérieure.
        low = engine.handle_action(2, {"action": "bid", "category": "star", "value": 3})
        self.assertEqual(low["error"], "bid-too-low")
        self.assertEqual(low["min"], 4)

    def test_doubt_without_bid_is_rejected(self):
        engine = UnPourCentEngine([1, 2])
        engine.in_round = [1, 2]
        engine.turn_idx = 0
        engine.current_bid = None
        engine.phase = "bidding"
        self.assertEqual(engine.handle_action(1, {"action": "doubt"})["error"], "nothing-to-doubt")

    def test_two_player_doubt_resolves_directly(self):
        engine = UnPourCentEngine([1, 2])
        engine.in_round = [1, 2]
        engine.turn_idx = 0
        engine.phase = "bidding"
        engine.current_bid = None
        engine.hands[1] = [draw("shark", 5)]
        engine.hands[2] = [draw("shark", 1)]

        engine.handle_action(1, {"action": "bid", "category": "shark", "value": 4})
        # Player 2 doubts. Actual shark sum = 6 >= 4 -> accused (1) truthful, wins.
        res = engine.handle_action(2, {"action": "doubt"})
        self.assertEqual(res["next"], "reward")
        self.assertEqual(engine.phase, "reward")
        self.assertEqual(engine.reward_player, 1)
        self.assertIn(2, engine.eliminated)
        self.assertTrue(res["reveal"]["accused_truthful"])

    def test_bluff_caught_eliminates_liar_and_wrong_voter(self):
        engine = UnPourCentEngine([1, 2, 3])
        engine.in_round = [1, 2, 3]
        engine.turn_idx = 0
        engine.phase = "bidding"
        engine.current_bid = None
        engine.hands[1] = [draw("shark", 2)]
        engine.hands[2] = [draw("shark", 1)]
        engine.hands[3] = [draw("shark", 1)]  # total shark = 4

        # Player 1 bids a lie (10 > 4).
        engine.handle_action(1, {"action": "bid", "category": "shark", "value": 10})
        # Player 2 doubts -> voting, voter is player 3.
        res = engine.handle_action(2, {"action": "doubt"})
        self.assertTrue(res["ok"])
        self.assertEqual(engine.phase, "voting")
        self.assertEqual(engine.serialize()["voters"], [3])

        # Player 3 votes for the accused (wrong: the bid was a lie).
        result = engine.handle_action(3, {"action": "vote", "choice": "accused"})
        self.assertEqual(result["next"], "reward")
        # Liar (1) and wrong voter (3) eliminated; accuser (2) survives -> reward.
        self.assertEqual(engine.reward_player, 2)
        self.assertIn(1, engine.eliminated)
        self.assertIn(3, engine.eliminated)
        self.assertFalse(result["reveal"]["accused_truthful"])

    def test_bluff_caught_correct_vote_starts_new_duel(self):
        engine = UnPourCentEngine([1, 2, 3])
        engine.in_round = [1, 2, 3]
        engine.turn_idx = 0
        engine.phase = "bidding"
        engine.current_bid = None
        engine.hands[1] = [draw("star", 1)]
        engine.hands[2] = [draw("star", 1)]
        engine.hands[3] = [draw("star", 1)]  # total star = 3

        engine.handle_action(1, {"action": "bid", "category": "star", "value": 9})  # lie
        engine.handle_action(2, {"action": "doubt"})  # voters = [3]
        result = engine.handle_action(3, {"action": "vote", "choice": "accuser"})  # correct
        # Only the liar (1) is eliminated; 2 and 3 survive -> new duel.
        self.assertEqual(result["next"], "duel")
        self.assertEqual(set(engine.in_round), {2, 3})
        self.assertEqual(engine.phase, "bidding")
        self.assertIn(1, engine.eliminated)

    def test_reward_take_card_unlocks_number(self):
        engine = UnPourCentEngine([1, 2])
        engine.phase = "reward"
        engine.reward_player = 1
        engine.reward_actions_left = 3
        engine.center = [{"kind": "reward", "value": 7}]
        res = engine.handle_action(1, {"action": "take_center", "index": 0})
        self.assertTrue(res["ok"])
        self.assertIn(7, engine.reward_numbers[1])
        self.assertEqual(engine.winning_numbers(1), [0, 7])
        self.assertEqual(engine.win_probability_percent(1), 4.0)

    def test_reward_roll_win_sets_winner(self):
        engine = UnPourCentEngine([1, 2])
        engine.phase = "reward"
        engine.reward_player = 1
        engine.reward_actions_left = 3
        with patch("game.games.un_pourcent.engine.random.choice", side_effect=[0, 0]):
            res = engine.handle_action(1, {"action": "roll"})
        self.assertTrue(res["win"])
        self.assertEqual(engine.winner, 1)
        self.assertEqual(engine.phase, "game_over")

    def test_reroll_bonus_can_turn_a_loss_into_a_win(self):
        engine = UnPourCentEngine([1, 2])
        engine.phase = "reward"
        engine.reward_player = 1
        engine.reward_actions_left = 1
        engine.reward_numbers[1] = [7]  # winning numbers {0, 7}
        engine.bonuses[1] = ["reroll"]
        # Roll gives 3 and 7 -> loss (3 not winning).
        with patch("game.games.un_pourcent.engine.random.choice", side_effect=[3, 7]):
            roll = engine.handle_action(1, {"action": "roll"})
        self.assertFalse(roll["win"])
        # Reroll die 0 -> 7, dice become 7,7 -> win.
        with patch("game.games.un_pourcent.engine.random.choice", side_effect=[7]):
            res = engine.handle_action(1, {"action": "use_bonus", "power": "reroll", "die": 0})
        self.assertTrue(res["win"])
        self.assertEqual(engine.winner, 1)
        self.assertNotIn("reroll", engine.bonuses[1])

    def test_reward_exhausted_starts_new_turn(self):
        engine = UnPourCentEngine([1, 2])
        engine.phase = "reward"
        engine.reward_player = 1
        engine.reward_actions_left = 1
        engine.bonuses[1] = []
        engine.discard = [draw("shark", 3)]
        # Losing roll (winning numbers {0}, dice 1,1) consumes the last action.
        with patch("game.games.un_pourcent.engine.random.choice", side_effect=[1, 1]):
            engine.handle_action(1, {"action": "roll"})
        self.assertIsNone(engine.winner)
        self.assertEqual(engine.phase, "bidding")
        self.assertEqual(set(engine.in_round), {1, 2})
        self.assertIsNone(engine.reward_player)

    def test_category_sum_only_counts_in_round(self):
        engine = UnPourCentEngine([1, 2, 3])
        engine.in_round = [1, 2]
        engine.hands[1] = [draw("comet", 4), draw("shark", 2)]
        engine.hands[2] = [draw("comet", 1)]
        engine.hands[3] = [draw("comet", 5)]  # not in round -> ignored
        self.assertEqual(engine.category_sum("comet"), 5)
