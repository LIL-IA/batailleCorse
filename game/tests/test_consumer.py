from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings
from channels.testing import WebsocketCommunicator
from asgiref.sync import async_to_sync

from game.models import Room, Player
from game.consumers import ENGINES, SLAP_CTX
from game.engine import GameEngine
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

    def test_start_marks_room_started(self):
        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            await communicator.receive_json_from()
            await communicator.send_json_to({"type": "start"})
            await communicator.receive_json_from()
            await communicator.disconnect()

        async_to_sync(inner)()
        self.room.refresh_from_db()
        assert self.room.is_started is True

    def test_start_fails_with_insufficient_players(self):
        Player.objects.filter(room=self.room, user=self.user2).delete()

        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            await communicator.receive_json_from()
            await communicator.send_json_to({"type": "start"})
            response = await communicator.receive_json_from()
            assert response["error"] == "not-enough-players"
            await communicator.disconnect()

        async_to_sync(inner)()
        self.room.refresh_from_db()
        assert self.room.is_started is False

    def test_connect_resets_engine_only_if_not_started(self):
        async def connect_and_get_engine():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            await communicator.receive_json_from()
            engine = ENGINES[self.room.code]
            await communicator.disconnect()
            return engine

        def run(started):
            ENGINES.clear()
            engine_initial = ENGINES[self.room.code] = GameEngine([self.user1.id, self.user2.id])
            self.room.is_started = started
            self.room.save()
            engine_after = async_to_sync(connect_and_get_engine)()
            return engine_initial, engine_after

        init, after = run(False)
        assert after is not init

        init, after = run(True)
        assert after is init
