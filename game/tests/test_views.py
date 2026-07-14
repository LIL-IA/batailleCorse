from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.urls import reverse

from game.models import Player, Room, GameState
from game.engine import GameEngine


@override_settings(
    STATICFILES_STORAGE="django.contrib.staticfiles.storage.StaticFilesStorage"
)
class CreateRoomViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("host", password="pass123")
        self.client.force_login(self.user)

    def test_redirects_to_existing_room_when_started_room_exists(self):
        room = Room.objects.create(code="ABC123", host=self.user, is_started=True)
        Player.objects.create(room=room, user=self.user, seat=0)

        response = self.client.post(reverse("create_room"), follow=True)

        self.assertRedirects(response, reverse("room", args=[room.code]))
        self.assertEqual(Room.objects.count(), 1)
        self.assertEqual(Player.objects.filter(room=room).count(), 1)
        messages = list(response.context["messages"])
        self.assertEqual(len(messages), 1)
        self.assertIn(room.code, str(messages[0]))

    def test_creates_new_room_when_no_started_room(self):
        existing = Room.objects.create(code="OLD001", host=self.user, is_started=False)
        Player.objects.create(room=existing, user=self.user, seat=0)

        with patch("game.views._gen_unique_code", return_value="NEW001"):
            response = self.client.post(reverse("create_room"))

        self.assertRedirects(response, reverse("room", args=["NEW001"]))
        self.assertEqual(Room.objects.count(), 2)
        new_room = Room.objects.get(code="NEW001")
        self.assertEqual(new_room.host, self.user)
        self.assertTrue(new_room.players.filter(user=self.user).exists())

    def test_creates_new_room_when_only_unstarted_room_exists(self):
        waiting_room = Room.objects.create(code="WAIT01", host=self.user, is_started=False)
        Player.objects.create(room=waiting_room, user=self.user, seat=0)

        with patch("game.views._gen_unique_code", return_value="NEW001"):
            response = self.client.post(reverse("create_room"))

        self.assertRedirects(response, reverse("room", args=["NEW001"]))
        self.assertTrue(Room.objects.filter(code="WAIT01").exists())
        self.assertEqual(Room.objects.count(), 2)


@override_settings(
    STATICFILES_STORAGE="django.contrib.staticfiles.storage.StaticFilesStorage"
)
class JoinRoomViewTests(TestCase):
    def setUp(self):
        self.host = User.objects.create_user("host", password="pass123")
        self.room = Room.objects.create(code="FULL12", host=self.host)
        Player.objects.create(room=self.room, user=self.host, seat=0)
        for i in range(1, 12):
            player = User.objects.create_user(f"player{i}", password="pass123")
            Player.objects.create(room=self.room, user=player, seat=i)
        self.user = User.objects.create_user("latecomer", password="pass123")
        self.client.force_login(self.user)

    def test_cannot_join_full_room(self):
        response = self.client.post(
            reverse("join_room"), {"code": self.room.code}, follow=True
        )

        self.assertRedirects(response, reverse("join_room"))
        self.assertEqual(Player.objects.filter(room=self.room).count(), 12)
        messages = list(response.context["messages"])
        self.assertEqual(len(messages), 1)
        self.assertEqual(str(messages[0]), "Cette salle est pleine.")


@override_settings(
    STATICFILES_STORAGE="django.contrib.staticfiles.storage.StaticFilesStorage"
)
class RoomViewTests(TestCase):
    def setUp(self):
        self.host = User.objects.create_user("roomhost", password="pass123")
        self.client.force_login(self.host)

    def test_initial_options_uses_room_rules_when_not_started(self):
        room = Room.objects.create(
            code="OPT001",
            host=self.host,
            game_selected=True,
            rules_options={
                "allow_sandwich": False,
                "bad_slap_penalty": 5,
            },
        )
        Player.objects.create(room=room, user=self.host, seat=0)
        GameState.objects.create(
            room=room,
            state_json={
                "options": {
                    "allow_sandwich": True,
                    "bad_slap_penalty": 1,
                }
            },
        )

        response = self.client.get(reverse("room", args=[room.code]))

        self.assertEqual(response.status_code, 200)
        expected_options = GameEngine.sanitize_options(base=room.rules_options)
        self.assertEqual(response.context["initial_options"], expected_options)

    def test_bataille_corse_room_uses_default_template(self):
        room = Room.objects.create(
            code="BC0001",
            host=self.host,
            game_type="bataille_corse",
            game_selected=True,
        )
        Player.objects.create(room=room, user=self.host, seat=0)

        response = self.client.get(reverse("room", args=[room.code]))

        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "game/room.html")
        self.assertContains(response, 'id="penalty-pile"')

    def test_one_percent_room_uses_its_own_template(self):
        room = Room.objects.create(
            code="ONE001",
            host=self.host,
            game_type="1_percent",
            game_selected=True,
        )
        Player.objects.create(room=room, user=self.host, seat=0)

        response = self.client.get(reverse("room", args=[room.code]))

        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "game/room_un_pourcent.html")
        self.assertContains(response, 'id="up-root"')
        self.assertContains(response, "un_pourcent.css")
