from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings
from channels.testing import WebsocketCommunicator
from asgiref.sync import async_to_sync, sync_to_async

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
            await communicator.send_json_to({"type": "ready", "value": True})
            await communicator.receive_json_from()
            other = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            other.scope["user"] = self.user2
            connected, _ = await other.connect()
            assert connected
            await other.receive_json_from()
            await other.send_json_to({"type": "ready", "value": True})
            await communicator.receive_json_from()
            await other.receive_json_from()
            await communicator.send_json_to({"type": "start"})
            await communicator.receive_json_from()
            await other.receive_json_from()
            await other.disconnect()
            await communicator.disconnect()

        async_to_sync(inner)()
        self.room.refresh_from_db()
        assert self.room.is_started is True

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

    def test_ready_and_start_requires_all_ready(self):
        async def inner():
            comm1 = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            comm1.scope["user"] = self.user1
            connected, _ = await comm1.connect()
            assert connected
            await comm1.receive_json_from()

            comm2 = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            comm2.scope["user"] = self.user2
            connected, _ = await comm2.connect()
            assert connected
            await comm2.receive_json_from()
            await comm1.receive_json_from()

            await comm1.send_json_to({"type": "ready", "value": True})
            await comm1.receive_json_from()
            await comm2.receive_json_from()

            await comm2.send_json_to({"type": "ready", "value": False})
            await comm1.receive_json_from()
            await comm2.receive_json_from()

            ready1 = await sync_to_async(lambda: Player.objects.get(room=self.room, user=self.user1).is_ready)()
            ready2 = await sync_to_async(lambda: Player.objects.get(room=self.room, user=self.user2).is_ready)()
            assert ready1 is True
            assert ready2 is False

            await comm1.send_json_to({"type": "start"})
            resp = await comm1.receive_json_from()
            assert resp["error"] == "not-ready"

            await comm2.send_json_to({"type": "ready", "value": True})
            await comm1.send_json_to({"type": "start"})
            await comm1.receive_json_from()
            await comm2.receive_json_from()

            await comm1.disconnect()
            await comm2.disconnect()

        async_to_sync(inner)()
        self.room.refresh_from_db()
        assert self.room.is_started is True
        assert Player.objects.filter(room=self.room, is_ready=True).count() == 0
