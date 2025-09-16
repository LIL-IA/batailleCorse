from collections import deque
from django.test import SimpleTestCase

from game.engine import GameEngine


class GameEngineTests(SimpleTestCase):
    def test_deal_distribution(self):
        engine = GameEngine([1, 2])
        self.assertEqual(len(engine.hands[1]), 26)
        self.assertEqual(len(engine.hands[2]), 26)
        self.assertEqual(sum(len(h) for h in engine.hands.values()), 52)
        self.assertEqual(len(engine.center), 0)

    def test_slap_validity(self):
        engine = GameEngine([1, 2])
        engine.center = ['5H', '5D']
        self.assertTrue(engine.is_slap_valid())
        engine.center = ['5H', '7D', '5S']
        self.assertTrue(engine.is_slap_valid())
        engine.center = ['5H', '7D']
        self.assertFalse(engine.is_slap_valid())

    def test_ten_based_slap_rules(self):
        engine = GameEngine([1, 2])

        engine.center = ['TH']
        self.assertTrue(engine.is_slap_valid())

        engine.center = ['2H', '8D']
        self.assertTrue(engine.is_slap_valid())

        engine.center = ['2H', '5D', '8S']
        self.assertTrue(engine.is_slap_valid())

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
        self.assertEqual(engine.center, ['2H', '3D'])

    def test_serialize_includes_last_three_center(self):
        engine = GameEngine([1, 2])
        engine.center = []
        serialized = engine.serialize()
        self.assertIn('last_three_center', serialized)
        self.assertEqual(serialized['last_three_center'], [])

        engine.center = ['2H', '3D']
        serialized = engine.serialize()
        self.assertEqual(serialized['last_three_center'], ['2H', '3D'])

        engine.center.extend(['4S', '5C', '6D'])
        serialized = engine.serialize()
        self.assertEqual(serialized['last_three_center'], ['4S', '5C', '6D'])
