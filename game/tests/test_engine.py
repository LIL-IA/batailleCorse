from collections import deque
from unittest.mock import patch

from django.test import SimpleTestCase

from game.engine import GameEngine


class GameEngineTests(SimpleTestCase):
    def test_deal_distribution(self):
        engine = GameEngine([1, 2])
        self.assertEqual(len(engine.hands[1]), 26)
        self.assertEqual(len(engine.hands[2]), 26)
        expected_cards = engine._resolve_deck_count() * 52
        self.assertEqual(sum(len(h) for h in engine.hands.values()), expected_cards)
        self.assertEqual(len(engine.center), 0)

    def test_deal_distribution_auto_mode_scales_with_players(self):
        players = list(range(1, 10))
        engine = GameEngine(players)
        self.assertEqual(engine._resolve_deck_count(), 3)
        total_cards = sum(len(h) for h in engine.hands.values())
        self.assertEqual(total_cards, 3 * 52)

    def test_manual_mode_uses_configured_deck_count(self):
        engine = GameEngine([1, 2, 3], options={'deck_mode': 'manual', 'deck_count': 3})
        self.assertEqual(engine.options['deck_mode'], 'manual')
        self.assertEqual(engine.options['deck_count'], 3)
        total_cards = sum(len(h) for h in engine.hands.values())
        self.assertEqual(total_cards, 3 * 52)

    def test_initial_turn_idx_uses_random_selection(self):
        with patch('game.engine.random.randrange', return_value=1):
            engine = GameEngine([1, 2, 3])

        self.assertEqual(engine.turn_idx, 1)
        self.assertEqual(engine.players[engine.turn_idx], 2)

    def test_slap_validity(self):
        engine = GameEngine([1, 2])
        engine.center = ['5H', '5D']
        self.assertTrue(engine.is_slap_valid())
        engine.center = ['5H', '7D', '5S']
        self.assertTrue(engine.is_slap_valid())
        engine.center = ['5H', '7D']
        self.assertFalse(engine.is_slap_valid())

    def test_ten_card_rule_toggle(self):
        engine = GameEngine([
            1,
            2,
        ], options={
            'allow_ten_card': False,
            'allow_ten_sum': False,
            'allow_ten_sandwich': False,
        })

        engine.center = ['TH']
        self.assertFalse(engine.is_slap_valid())

        engine.update_options({'allow_ten_card': True})
        self.assertTrue(engine.is_slap_valid())

        engine.center = ['2H', '8D']
        self.assertFalse(engine.is_slap_valid())

    def test_ten_sum_rule_toggle(self):
        engine = GameEngine([
            1,
            2,
        ], options={
            'allow_ten_card': False,
            'allow_ten_sum': False,
            'allow_ten_sandwich': False,
        })

        engine.center = ['2H', '8D']
        self.assertFalse(engine.is_slap_valid())

        engine.update_options({'allow_ten_sum': True})
        self.assertTrue(engine.is_slap_valid())

        engine.center = ['TH']
        self.assertFalse(engine.is_slap_valid())

    def test_ten_sandwich_rule_toggle(self):
        engine = GameEngine([
            1,
            2,
        ], options={
            'allow_ten_card': False,
            'allow_ten_sum': False,
            'allow_ten_sandwich': False,
        })

        engine.center = ['2H', '5D', '8S']
        self.assertFalse(engine.is_slap_valid())

        engine.update_options({'allow_ten_sandwich': True})
        self.assertTrue(engine.is_slap_valid())

        engine.center = ['TH']
        self.assertFalse(engine.is_slap_valid())

    def test_face_card_rules(self):
        engine = GameEngine([1, 2])
        engine.hands[1] = deque(['AH'])
        engine.hands[2] = deque(['3D', '4D', '5D', '6D'])
        engine.center = []
        engine.turn_idx = 0

        res = engine.play_card(1)
        self.assertTrue(res['ok'])
        self.assertEqual(engine.face_chances, 4)
        self.assertEqual(engine.turn_idx, 1)

        for _ in range(4):
            res = engine.play_card(2)
            self.assertTrue(res['ok'])

        self.assertEqual(engine.face_chances, 0)
        self.assertEqual(engine.turn_idx, 0)
        self.assertTrue(engine.pending_collect)
        self.assertEqual(engine.collect_winner, 1)
        self.assertEqual(len(engine.center), 5)
        self.assertEqual(len(engine.hands[1]), 0)
        self.assertEqual(len(engine.hands[2]), 0)

        collect_res = engine.play_card(1)
        self.assertTrue(collect_res['ok'])
        self.assertTrue(collect_res['collected'])
        self.assertEqual(engine.turn_idx, 0)
        self.assertFalse(engine.pending_collect)
        self.assertIsNone(engine.collect_winner)
        self.assertEqual(len(engine.center), 0)
        self.assertEqual(len(engine.hands[1]), 5)
        self.assertEqual(len(engine.hands[2]), 0)

    def test_invalid_slap_penalizes_two_cards(self):
        engine = GameEngine([1, 2])
        engine.hands[1] = deque(['2H', '3D', '4S'])
        engine.hands[2] = deque()
        engine.center = []

        result = engine.slap(1)

        self.assertTrue(result['ok'])
        self.assertFalse(result['valid'])
        self.assertEqual(result['penalized'], 2)
        self.assertEqual(list(engine.hands[1]), ['4S'])
        self.assertEqual(engine.center, [])
        self.assertEqual(engine.penalties, ['2H', '3D'])

    def test_play_card_out_of_turn_penalizes_two_cards(self):
        engine = GameEngine([1, 2])
        engine.hands[1] = deque(['2H', '3D', '4S'])
        engine.hands[2] = deque(['5C'])
        engine.center = ['9H']
        engine.turn_idx = 1  # player's index 1 corresponds to player 2's turn

        result = engine.play_card(1)

        self.assertEqual(result['error'], 'not-your-turn')
        self.assertEqual(result['penalized'], 2)
        self.assertEqual(list(engine.hands[1]), ['4S'])
        self.assertEqual(engine.center, ['9H'])
        self.assertEqual(engine.penalties, ['2H', '3D'])

    def test_serialize_includes_last_four_center(self):
        engine = GameEngine([1, 2])
        engine.center = []
        serialized = engine.serialize()
        self.assertIn('last_four_center', serialized)
        self.assertEqual(serialized['last_four_center'], [])

        engine.center = ['2H', '3D']
        serialized = engine.serialize()
        self.assertEqual(serialized['last_four_center'], ['2H', '3D'])

        engine.center.extend(['4S', '5C', '6D'])
        serialized = engine.serialize()
        self.assertEqual(serialized['last_four_center'], ['3D', '4S', '5C', '6D'])

    def test_pending_collect_keeps_center_visible_until_winner_confirms(self):
        engine = GameEngine([1, 2])
        engine.hands[1] = deque(['JH'])
        engine.hands[2] = deque(['3D'])
        engine.center = []
        engine.turn_idx = 0

        first = engine.play_card(1)
        self.assertTrue(first['ok'])
        second = engine.play_card(2)
        self.assertTrue(second['ok'])

        self.assertTrue(engine.pending_collect)
        self.assertEqual(engine.collect_winner, 1)
        self.assertEqual(len(engine.center), 2)

        serialized = engine.serialize()
        self.assertEqual(serialized['center_count'], 2)
        self.assertEqual(serialized['top_center'], '3D')
        self.assertTrue(serialized['pending_collect'])
        self.assertEqual(serialized['collect_winner'], 1)

        collect = engine.play_card(1)
        self.assertTrue(collect['ok'])
        self.assertTrue(collect['collected'])
        self.assertEqual(len(engine.center), 0)
        self.assertFalse(engine.pending_collect)
        self.assertIsNone(engine.collect_winner)
        self.assertEqual(len(engine.hands[1]), 2)

        serialized_after = engine.serialize()
        self.assertEqual(serialized_after['center_count'], 0)
        self.assertFalse(serialized_after['pending_collect'])
        self.assertIsNone(serialized_after['collect_winner'])

    def test_penalty_cards_placed_under_pile_on_collect(self):
        engine = GameEngine([1, 2])
        engine.hands[1] = deque(['AH'])
        engine.hands[2] = deque()
        engine.center = ['5S']
        engine.penalties = ['9H', '8D']

        engine._collect_center(1)

        self.assertEqual(list(engine.hands[1]), ['AH', '5S', '9H', '8D'])
        self.assertEqual(engine.center, [])
        self.assertEqual(engine.penalties, [])

    def test_serialize_includes_penalty_count(self):
        engine = GameEngine([1, 2])
        engine.penalties = ['2H', '3D']
        serialized = engine.serialize()
        self.assertIn('penalty_count', serialized)
        self.assertEqual(serialized['penalty_count'], 2)

    def test_sanitize_options_clamps_negative_penalties(self):
        sanitized = GameEngine.sanitize_options({
            'bad_slap_penalty': -3,
            'bad_play_penalty': '-2',
        })
        self.assertEqual(sanitized['bad_slap_penalty'], 0)
        self.assertEqual(sanitized['bad_play_penalty'], 0)

    def test_sanitize_options_limits_penalty_values(self):
        sanitized = GameEngine.sanitize_options({
            'bad_slap_penalty': 8,
            'bad_play_penalty': 4,
        })
        self.assertEqual(sanitized['bad_slap_penalty'], 5)
        self.assertEqual(sanitized['bad_play_penalty'], 4)

    def test_sanitize_options_translates_legacy_penalty_mode(self):
        sanitized = GameEngine.sanitize_options({'penalty_mode': 'mort subite'})
        self.assertTrue(sanitized['bad_slap_sudden_death'])
        self.assertTrue(sanitized['bad_play_sudden_death'])
        self.assertNotIn('penalty_mode', sanitized)

    def test_sanitize_options_normalizes_deck_settings(self):
        sanitized = GameEngine.sanitize_options({
            'deck_mode': 'Manuel',
            'deck_count': 5,
        })
        self.assertEqual(sanitized['deck_mode'], 'manual')
        self.assertEqual(sanitized['deck_count'], 3)

    def test_sanitize_options_coerces_boolean_values(self):
        sanitized = GameEngine.sanitize_options({
            'allow_double': 'false',
            'allow_runs': 'TRUE',
        })
        self.assertFalse(sanitized['allow_double'])
        self.assertTrue(sanitized['allow_runs'])

    def test_sanitize_options_supports_allow_ten_alias(self):
        sanitized = GameEngine.sanitize_options({'allow_ten': False})
        self.assertFalse(sanitized['allow_ten_card'])
        self.assertFalse(sanitized['allow_ten_sum'])
        self.assertFalse(sanitized['allow_ten_sandwich'])

        sanitized_true = GameEngine.sanitize_options({'allow_ten': 'on'})
        self.assertTrue(sanitized_true['allow_ten_card'])
        self.assertTrue(sanitized_true['allow_ten_sum'])
        self.assertTrue(sanitized_true['allow_ten_sandwich'])

        sanitized_override = GameEngine.sanitize_options({
            'allow_ten': False,
            'allow_ten_card': True,
        })
        self.assertTrue(sanitized_override['allow_ten_card'])
        self.assertFalse(sanitized_override['allow_ten_sum'])
        self.assertFalse(sanitized_override['allow_ten_sandwich'])

    def test_sanitize_options_merges_with_base(self):
        base = {
            'allow_double': False,
            'bad_slap_penalty': 5,
        }
        overrides = {
            'allow_runs': '1',
            'bad_play_penalty': 1,
        }
        sanitized = GameEngine.sanitize_options(overrides=overrides, base=base)
        self.assertFalse(sanitized['allow_double'])
        self.assertTrue(sanitized['allow_runs'])
        self.assertEqual(sanitized['bad_slap_penalty'], 5)
        self.assertEqual(sanitized['bad_play_penalty'], 1)

    def test_invalid_slap_penalty_can_be_disabled(self):
        engine = GameEngine([1, 2], options={'bad_slap_penalty': 0})
        engine.hands[1] = deque(['2H'])
        result = engine.slap(1)
        self.assertEqual(result['penalized'], 0)
        self.assertEqual(engine.penalties, [])

    def test_sudden_death_mode_removes_all_cards(self):
        engine = GameEngine([1, 2], options={'penalty_mode': 'sudden_death'})
        engine.hands[1] = deque(['2H', '3D', '4S'])
        result = engine.slap(1)
        self.assertTrue(result['ok'])
        self.assertEqual(result['penalized'], 3)
        self.assertEqual(list(engine.hands[1]), [])
        self.assertEqual(engine.penalties, ['2H', '3D', '4S'])
        self.assertTrue(engine.options['bad_slap_sudden_death'])
        self.assertNotIn('penalty_mode', engine.options)

    def test_out_of_turn_penalty_uses_sudden_death_mode(self):
        engine = GameEngine([1, 2], options={'penalty_mode': 'mort-subite'})
        engine.hands[1] = deque(['2H', '3D'])
        engine.hands[2] = deque(['4S'])
        engine.turn_idx = 1
        result = engine.play_card(1)
        self.assertEqual(result['penalized'], 2)
        self.assertEqual(list(engine.hands[1]), [])
        self.assertEqual(engine.penalties, ['2H', '3D'])
        self.assertTrue(engine.options['bad_play_sudden_death'])
        self.assertNotIn('penalty_mode', engine.options)

    def test_set_options_applies_sanitized_values(self):
        engine = GameEngine([1, 2])
        updated = engine.set_options({'bad_slap_penalty': -4, 'allow_ten': '0'})
        self.assertEqual(updated['bad_slap_penalty'], 0)
        self.assertEqual(engine.options['bad_slap_penalty'], 0)
        for key in ('allow_ten_card', 'allow_ten_sum', 'allow_ten_sandwich'):
            self.assertFalse(updated[key])
            self.assertFalse(engine.options[key])
