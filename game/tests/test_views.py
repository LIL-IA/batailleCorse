from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.urls import reverse

from game.models import Player, Room


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
