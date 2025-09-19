import asyncio
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TransactionTestCase, override_settings
from channels.testing import WebsocketCommunicator
from asgiref.sync import async_to_sync, sync_to_async

from game.models import Room, Player
from game.consumers import (
    CONNECTION_COUNTS,
    ENGINES,
    PENDING_FINAL_DISCONNECTS,
    READY,
    ROOM_CONNECTION_COUNTS,
    ROOM_OPTIONS,
    SLAP_CTX,
)
from game.engine import GameEngine
from project.asgi import application


@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class RoomConsumerTests(TransactionTestCase):
    def setUp(self):
        ENGINES.clear()
        SLAP_CTX.clear()
        ROOM_OPTIONS.clear()
        READY.clear()
        CONNECTION_COUNTS.clear()
        ROOM_CONNECTION_COUNTS.clear()
        PENDING_FINAL_DISCONNECTS.clear()
        delay_patcher = patch("game.consumers.FINAL_DISCONNECT_DELAY_SECONDS", 0.01)
        self.addCleanup(delay_patcher.stop)
        delay_patcher.start()
        self.user1 = User.objects.create_user("user1", password="pass")
        self.user2 = User.objects.create_user("user2", password="pass")
        self.room = Room.objects.create(code="abcd", host=self.user1)
        Player.objects.create(room=self.room, user=self.user1, seat=0)
        Player.objects.create(room=self.room, user=self.user2, seat=1)

    async def _wait_for_last_action_message(self, communicator, expected_type, timeout=1.0):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AssertionError(f"Timeout waiting for last action {expected_type}")
            message = await asyncio.wait_for(communicator.receive_json_from(), remaining)
            if message.get("type") != "state":
                continue
            last_action = message.get("lastAction")
            if last_action and last_action.get("type") == expected_type:
                return message

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

    def test_play_updates_last_card_timestamp(self):
        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            initial = await communicator.receive_json_from()
            assert initial["type"] == "state"
            ctx = SLAP_CTX[self.room.code]
            assert ctx.get("last_card_ns") is None

            engine = ENGINES[self.room.code]
            engine.center.clear()
            engine.pending_collect = False
            engine.collect_winner = None
            engine.hands[self.user1.id].clear()
            engine.hands[self.user1.id].appendleft("AH")
            engine.turn_idx = engine.players.index(self.user1.id)

            play_ns = 123456789
            with patch("game.consumers.time.time_ns", return_value=play_ns):
                await communicator.send_json_to({"type": "play"})
                state = await self._wait_for_last_action_message(communicator, "play")
            assert state["lastAction"]["type"] == "play"
            ctx = SLAP_CTX[self.room.code]
            assert ctx["last_card_ns"] == play_ns, ctx["last_card_ns"]

            await communicator.disconnect()

        async_to_sync(inner)()

    def test_slap_reaction_times_emitted(self):
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

            engine = ENGINES[self.room.code]
            engine.center.clear()
            engine.pending_collect = False
            engine.collect_winner = None
            engine.hands[self.user1.id].clear()
            engine.hands[self.user1.id].appendleft("AH")
            engine.turn_idx = engine.players.index(self.user1.id)

            try:
                play_ns = 1_000_000_000
                with patch("game.consumers.time.time_ns", return_value=play_ns):
                    await host.send_json_to({"type": "play"})
                    await self._wait_for_last_action_message(host, "play")
                    await self._wait_for_last_action_message(guest, "play")

                engine = ENGINES[self.room.code]
                engine.center = ["AH", "AS"]
                assert engine.is_slap_valid()

                host_slap_ns = play_ns + 1_500_000
                guest_slap_ns = play_ns + 3_000_000
                slap_values = [host_slap_ns, guest_slap_ns]

                def slap_side_effect():
                    if slap_values:
                        return slap_values.pop(0)
                    return guest_slap_ns

                with patch("game.consumers.time.time_ns", side_effect=slap_side_effect):
                    with patch("game.consumers.GRACE_MS", 5):
                        await host.send_json_to({"type": "slap"})
                        await guest.send_json_to({"type": "slap"})
                        resolved = await self._wait_for_last_action_message(host, "slap_resolved", timeout=2.0)
                        await self._wait_for_last_action_message(guest, "slap_resolved", timeout=2.0)

                last_action = resolved["lastAction"]
                assert last_action["type"] == "slap_resolved"
                baseline = last_action.get("baselineNs")
                assert baseline is not None
                assert int(baseline) == play_ns
                winner = last_action["winner"]
                assert int(winner["userId"]) == self.user1.id
                expected_host_reaction = host_slap_ns - play_ns
                assert int(winner["reaction_ns"]) == expected_host_reaction
                candidates = last_action["candidates"]
                assert isinstance(candidates, list)
                assert len(candidates) == 2
                candidate_map = {int(entry["userId"]): entry for entry in candidates}
                assert int(candidate_map[self.user1.id]["reaction_ns"]) == expected_host_reaction
                assert int(candidate_map[self.user2.id]["reaction_ns"]) == guest_slap_ns - play_ns
            finally:
                await host.disconnect()
                await guest.disconnect()

        async_to_sync(inner)()

    def test_host_can_update_room_options(self):
        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected

            initial = await communicator.receive_json_from()
            assert initial["type"] == "state"

            await communicator.send_json_to({
                "type": "update_rules",
                "options": {
                    "allow_runs": "true",
                    "bad_slap_penalty": 3,
                    "bad_play_penalty": "off",
                    "bad_slap_sudden_death": True,
                    "bad_play_sudden_death": True,
                    "deck_mode": "manual",
                    "deck_count": 4,
                },
            })

            update = await communicator.receive_json_from()
            assert update["type"] == "state"
            options = update["options"]
            assert options["allow_runs"] is True
            assert options["bad_slap_penalty"] == 3
            assert options["bad_play_penalty"] == 0
            assert options["bad_slap_sudden_death"] is True
            assert options["bad_play_sudden_death"] is True
            assert options["deck_mode"] == "manual"
            assert options["deck_count"] == 3
            engine = ENGINES[self.room.code]
            assert engine.options["allow_runs"] is True
            assert engine.options["bad_slap_penalty"] == 3
            assert engine.options["bad_play_penalty"] == 0
            assert engine.options["bad_slap_sudden_death"] is True
            assert engine.options["bad_play_sudden_death"] is True
            assert engine.options["deck_mode"] == "manual"
            assert engine.options["deck_count"] == 3

            stored_options = await sync_to_async(
                lambda: Room.objects.only("rules_options").get(pk=self.room.pk).rules_options
            )()
            assert stored_options["allow_runs"] is True
            assert stored_options["bad_slap_penalty"] == 3
            assert stored_options["bad_play_penalty"] == 0
            assert stored_options["bad_slap_sudden_death"] is True
            assert stored_options["bad_play_sudden_death"] is True
            assert stored_options["deck_mode"] == "manual"
            assert stored_options["deck_count"] == 3

            await communicator.disconnect()

        async_to_sync(inner)()

    def test_legacy_penalty_mode_cache_refreshes(self):
        ROOM_OPTIONS[self.room.code] = {"penalty_mode": "sudden_death"}
        self.room.rules_options = {"penalty_mode": "sudden_death"}
        self.room.save(update_fields=["rules_options"])

        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected

            initial = await communicator.receive_json_from()
            assert initial["type"] == "state"
            options = initial["options"]
            assert options["bad_slap_sudden_death"] is True
            assert options["bad_play_sudden_death"] is True
            cached = ROOM_OPTIONS[self.room.code]
            assert cached["bad_slap_sudden_death"] is True
            assert cached["bad_play_sudden_death"] is True
            stored = await sync_to_async(
                lambda: Room.objects.only("rules_options").get(pk=self.room.pk).rules_options
            )()
            assert stored["bad_slap_sudden_death"] is True
            assert stored["bad_play_sudden_death"] is True

            await communicator.disconnect()

        async_to_sync(inner)()

    def test_non_host_cannot_update_room_options(self):
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

            await guest.send_json_to({"type": "update_rules", "options": {"allow_runs": False}})
            error = await guest.receive_json_from()
            assert error["error"] == "not-host"

            await guest.disconnect()
            await host.disconnect()

        async_to_sync(inner)()

    def test_update_rules_requires_dictionary(self):
        async def inner():
            communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
            communicator.scope["user"] = self.user1
            connected, _ = await communicator.connect()
            assert connected
            await communicator.receive_json_from()

            await communicator.send_json_to({"type": "update_rules", "options": "oops"})
            error = await communicator.receive_json_from()
            assert error["error"] == "invalid-options"

            await communicator.disconnect()

        async_to_sync(inner)()

    def test_update_rules_rejected_when_game_started(self):
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
            await host.receive_json_from()
            await guest.receive_json_from()

            await host.send_json_to({"type": "update_rules", "options": {"allow_runs": False}})
            error = await host.receive_json_from()
            assert error["error"] == "game-started"

            await guest.disconnect()
            await host.disconnect()

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
            await asyncio.sleep(0.05)
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
            await asyncio.sleep(0.05)
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

    def test_quick_refresh_does_not_remove_player(self):
        async def inner():
            with patch("game.consumers.FINAL_DISCONNECT_DELAY_SECONDS", 0.05):
                communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
                communicator.scope["user"] = self.user1
                connected, _ = await communicator.connect()
                assert connected
                await communicator.receive_json_from()

                await communicator.disconnect()
                await asyncio.sleep(0.01)

                refreshed = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
                refreshed.scope["user"] = self.user1
                connected, _ = await refreshed.connect()
                assert connected
                await refreshed.receive_json_from()

                await asyncio.sleep(0.1)

                still_exists = await sync_to_async(
                    lambda: Player.objects.filter(room=self.room, user=self.user1).exists()
                )()
                assert still_exists is True
                assert (self.room.code, self.user1.id) not in PENDING_FINAL_DISCONNECTS

                await refreshed.disconnect()
                await asyncio.sleep(0.1)

        async_to_sync(inner)()

    def test_final_disconnect_cleanup_runs_after_delay(self):
        async def inner():
            with patch("game.consumers.FINAL_DISCONNECT_DELAY_SECONDS", 0.05):
                communicator = WebsocketCommunicator(application, f"/ws/room/{self.room.code}/")
                communicator.scope["user"] = self.user1
                connected, _ = await communicator.connect()
                assert connected
                await communicator.receive_json_from()

                await communicator.disconnect()
                await asyncio.sleep(0.1)

                exists = await sync_to_async(
                    lambda: Player.objects.filter(room=self.room, user=self.user1).exists()
                )()
                assert exists is False
                assert (self.room.code, self.user1.id) not in PENDING_FINAL_DISCONNECTS

                room_exists = await sync_to_async(
                    lambda: Room.objects.filter(pk=self.room.pk).exists()
                )()
                assert room_exists is True
                new_host = await sync_to_async(
                    lambda: Room.objects.get(pk=self.room.pk).host_id
                )()
                assert new_host == self.user2.id
                assert self.room.code not in ENGINES
                assert self.room.code not in SLAP_CTX
                assert self.room.code not in ROOM_OPTIONS
                assert self.room.code not in READY
                assert self.room.code not in ROOM_CONNECTION_COUNTS

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
            await asyncio.sleep(0.05)

            exists = await sync_to_async(lambda: Room.objects.filter(pk=self.room.pk).exists())()
            assert exists is False

        async_to_sync(inner)()
