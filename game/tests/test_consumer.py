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
            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is False
            await communicator.disconnect()

        async_to_sync(inner)()

    def test_host_can_stop_game(self):
        async def inner():
            host = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            host.scope["user"] = self.user1
            connected, _ = await host.connect()
            assert connected
            state = await host.receive_json_from()
            assert state["type"] == "state"

            guest = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            guest.scope["user"] = self.user2
            connected, _ = await guest.connect()
            assert connected
            state = await guest.receive_json_from()
            assert state["type"] == "state"
            state = await host.receive_json_from()
            assert state["type"] == "state"

            await host.send_json_to({"type": "ready", "value": True})
            state = await host.receive_json_from()
            assert state["type"] == "state"
            state = await guest.receive_json_from()
            assert state["type"] == "state"

            await guest.send_json_to({"type": "ready", "value": True})
            state = await host.receive_json_from()
            assert state["type"] == "state"
            state = await guest.receive_json_from()
            assert state["type"] == "state"

            await host.send_json_to({"type": "start"})
            state_host_started = await host.receive_json_from()
            state_guest_started = await guest.receive_json_from()
            assert state_host_started["started"] is True
            assert state_guest_started["started"] is True

            await host.send_json_to({"type": "stop"})
            state_host_stopped = await host.receive_json_from()
            state_guest_stopped = await guest.receive_json_from()
            assert state_host_stopped["started"] is False
            assert state_guest_stopped["started"] is False
            assert state_host_stopped.get("ready") == []
            assert state_guest_stopped.get("ready") == []

            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is False

            await guest.disconnect()
            await host.disconnect()

        async_to_sync(inner)()

    def test_non_host_cannot_stop_game(self):
        async def inner():
            host = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            host.scope["user"] = self.user1
            connected, _ = await host.connect()
            assert connected
            state = await host.receive_json_from()
            assert state["type"] == "state"

            guest = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            guest.scope["user"] = self.user2
            connected, _ = await guest.connect()
            assert connected
            state = await guest.receive_json_from()
            assert state["type"] == "state"
            state = await host.receive_json_from()
            assert state["type"] == "state"

            await host.send_json_to({"type": "ready", "value": True})
            state = await host.receive_json_from()
            assert state["type"] == "state"
            state = await guest.receive_json_from()
            assert state["type"] == "state"

            await guest.send_json_to({"type": "ready", "value": True})
            state = await host.receive_json_from()
            assert state["type"] == "state"
            state = await guest.receive_json_from()
            assert state["type"] == "state"

            await host.send_json_to({"type": "start"})
            state_host_started = await host.receive_json_from()
            state_guest_started = await guest.receive_json_from()
            assert state_host_started["started"] is True
            assert state_guest_started["started"] is True

            await guest.send_json_to({"type": "stop"})
            assert await guest.receive_nothing(timeout=0.1)
            assert await host.receive_nothing(timeout=0.1)

            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is True

            await guest.disconnect()
            await host.disconnect()

        async_to_sync(inner)()

    def test_host_can_restart_game(self):
        async def inner():
            host = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            host.scope["user"] = self.user1
            connected, _ = await host.connect()
            assert connected
            await host.receive_json_from()

            guest = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            guest.scope["user"] = self.user2
            connected, _ = await guest.connect()
            assert connected
            await guest.receive_json_from()
            await host.receive_json_from()

            await host.send_json_to({"type": "ready", "value": True})
            await host.receive_json_from()
            await guest.receive_json_from()

            await guest.send_json_to({"type": "ready", "value": True})
            await host.receive_json_from()
            await guest.receive_json_from()

            await host.send_json_to({"type": "start"})
            state_host_started = await host.receive_json_from()
            state_guest_started = await guest.receive_json_from()
            assert state_host_started["started"] is True
            assert state_guest_started["started"] is True

            await host.send_json_to({"type": "restart"})
            state_host_restarted = await host.receive_json_from()
            state_guest_restarted = await guest.receive_json_from()
            assert state_host_restarted["started"] is False
            assert state_guest_restarted["started"] is False
            assert state_host_restarted.get("ready") == []
            assert state_guest_restarted.get("ready") == []

            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is False

            await guest.disconnect()
            await host.disconnect()

        async_to_sync(inner)()

    def test_non_host_cannot_restart_game(self):
        async def inner():
            host = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            host.scope["user"] = self.user1
            connected, _ = await host.connect()
            assert connected
            await host.receive_json_from()

            guest = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            guest.scope["user"] = self.user2
            connected, _ = await guest.connect()
            assert connected
            await guest.receive_json_from()
            await host.receive_json_from()

            await host.send_json_to({"type": "ready", "value": True})
            await host.receive_json_from()
            await guest.receive_json_from()

            await guest.send_json_to({"type": "ready", "value": True})
            await host.receive_json_from()
            await guest.receive_json_from()

            await host.send_json_to({"type": "start"})
            state_host_started = await host.receive_json_from()
            state_guest_started = await guest.receive_json_from()
            assert state_host_started["started"] is True
            assert state_guest_started["started"] is True

            await guest.send_json_to({"type": "restart"})
            assert await guest.receive_nothing(timeout=0.1)
            assert await host.receive_nothing(timeout=0.1)

            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is True

            await guest.disconnect()
            await host.disconnect()

        async_to_sync(inner)()

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
            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is False
            await communicator.disconnect()

        async_to_sync(inner)()

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
            started_db = await sync_to_async(lambda: Room.objects.get(pk=self.room.pk).is_started)()
            assert started_db is False
            ready_count = await sync_to_async(lambda: Player.objects.filter(room=self.room, is_ready=True).count())()
            assert ready_count == 0
            await comm2.disconnect()

        async_to_sync(inner)()

    def test_ready_persists_when_new_player_connects(self):
        async def inner():
            comm1 = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            comm1.scope["user"] = self.user1
            connected, _ = await comm1.connect()
            assert connected
            await comm1.receive_json_from()

            await comm1.send_json_to({"type": "ready", "value": True})
            state = await comm1.receive_json_from()
            assert self.user1.id in state["ready"]

            comm2 = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            comm2.scope["user"] = self.user2
            connected, _ = await comm2.connect()
            assert connected

            state2 = await comm2.receive_json_from()
            state1 = await comm1.receive_json_from()

            assert self.user1.id in state1["ready"]
            assert self.user1.id in state2["ready"]

            await comm1.disconnect()
            await comm2.disconnect()

        async_to_sync(inner)()

    def test_room_deleted_when_last_player_leaves(self):
        async def inner():
            host = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            host.scope["user"] = self.user1
            connected, _ = await host.connect()
            assert connected
            await host.receive_json_from()

            guest = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            guest.scope["user"] = self.user2
            connected, _ = await guest.connect()
            assert connected

            await guest.receive_json_from()
            await host.receive_json_from()

            await host.disconnect()
            state_after_host_disconnect = await guest.receive_json_from()
            assert state_after_host_disconnect["type"] == "state"

            await guest.disconnect()

            exists = await sync_to_async(lambda: Room.objects.filter(pk=self.room.pk).exists())()
            assert exists is False

        async_to_sync(inner)()
