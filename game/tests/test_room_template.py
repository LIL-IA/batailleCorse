from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse

from game.models import Room, Player


class RoomTemplateTests(TestCase):
    def setUp(self):
        self.host = User.objects.create_user("host", password="pass")
        self.other = User.objects.create_user("other", password="pass")
        self.room = Room.objects.create(code="abcd", host=self.host)
        Player.objects.create(room=self.room, user=self.host, seat=0)
        Player.objects.create(room=self.room, user=self.other, seat=1)

    def test_start_button_visible_only_to_host(self):
        self.client.force_login(self.host)
        response = self.client.get(reverse("room", args=[self.room.code]))
        self.assertContains(response, "Démarrer une partie")

        self.client.force_login(self.other)
        response = self.client.get(reverse("room", args=[self.room.code]))
        self.assertNotContains(response, "Démarrer une partie")
