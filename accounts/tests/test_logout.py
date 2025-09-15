from django.contrib.auth.models import User
from django.urls import reverse
from django.test import TestCase


class LogoutViewTests(TestCase):
    def test_logout_via_post(self):
        user = User.objects.create_user(username="alice", password="secret")
        self.client.login(username="alice", password="secret")
        response = self.client.post(reverse("logout"))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("home"))
        self.assertNotIn("_auth_user_id", self.client.session)
