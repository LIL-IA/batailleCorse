from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.urls import reverse

from game.models import Room, Player


@override_settings(STATICFILES_STORAGE="django.contrib.staticfiles.storage.StaticFilesStorage")
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
        self.assertContains(response, 'id="start-btn"')
        self.assertContains(response, "if (startBtn && true)")

        self.client.force_login(self.other)
        response = self.client.get(reverse("room", args=[self.room.code]))
        self.assertContains(response, 'id="start-btn"')
        self.assertContains(response, "if (startBtn && false)")

    def test_room_contains_penalty_pile_container(self):
        self.client.force_login(self.host)
        response = self.client.get(reverse("room", args=[self.room.code]))
        self.assertContains(response, 'id="penalty-pile"')

    def test_room_options_include_deck_settings(self):
        self.client.force_login(self.host)
        response = self.client.get(reverse("room", args=[self.room.code]))
        self.assertContains(response, 'data-options-summary')
        self.assertContains(response, "Paquets")
        self.assertContains(response, 'data-option-key="deck_mode"', count=2)
        self.assertContains(response, 'value="auto"')
        self.assertContains(response, 'value="manual"')
        self.assertContains(response, 'data-deck-count-container')
        self.assertContains(response, 'data-option-key="deck_count"', count=3)
        self.assertContains(response, 'value="1"')
        self.assertContains(response, 'value="2"')
        self.assertContains(response, 'value="3"')
