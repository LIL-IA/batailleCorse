from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings
from channels.testing import WebsocketCommunicator
from asgiref.sync import async_to_sync

from game.models import Room, Player
from game.consumers import ENGINES, SLAP_CTX
from project.asgi import application


@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class RoomConsumerTests(TransactionTestCase):
    def setUp(self):
        ENGINES.clear()
        SLAP_CTX.clear()
        self.user1 = User.objects.create_user("user1", password="pass")
        self.user2 = User.objects.create_user("user2", password="pass")
        self.room = Room.objects.create(code="abcd", host=self.user1)
        Player.objects.create(room=self.room, user=self.user1, seat=0)
        Player.objects.create(room=self.room, user=self.user2, seat=1)

    def test_play_flow(self):
        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            initial = await communicator.receive_json_from()
            assert initial["type"] == "state"
            await communicator.send_json_to({"type": "play"})
            response = await communicator.receive_json_from()
            assert response["type"] == "state"
            assert response["lastAction"]["type"] == "play"
            await communicator.disconnect()

        async_to_sync(inner)()
