import time
import asyncio
import logging
from collections import defaultdict
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from .models import Room, GameState, Player
from .engine import GameEngine

logger = logging.getLogger(__name__)

ENGINES = {}
SLAP_CTX = {}
READY = {}
CONNECTION_COUNTS = defaultdict(int)
# Delay in milliseconds to collect all slap candidates before resolving
GRACE_MS = 1000

class RoomConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        try:
            self.room_code = self.scope['url_route']['kwargs']['room_code']
            self.group = f"room_{self.room_code}"
            user = self.scope.get("user")
            if isinstance(user, AnonymousUser) or not user.is_authenticated:
                await self.close()
                return
            await self.channel_layer.group_add(self.group, self.channel_name)
            await self.accept()
            self.user_id = user.id
            self._connection_key = (self.room_code, self.user_id)
            CONNECTION_COUNTS[self._connection_key] += 1
            READY.setdefault(self.room_code, set())
            if await self._is_room_started():
                await self._ensure_engine()
            else:
                await self._reset_engine(clear_ready=False)
            engine = ENGINES.get(self.room_code)
            db_players = await self._players_order()
            if engine and set(db_players) != set(engine.players):
                extra = set(db_players) - set(engine.players)
                if extra and not await self._is_started():
                    await self._reset_engine(clear_ready=False)
            await self._ensure_slap_ctx()
            await self._broadcast_state()
            logger.debug("User %s connected to room %s", user.id, self.room_code)
        except Exception:
            logger.exception("Error in connect")
            await self.close()

    async def receive_json(self, content, **kwargs):
        try:
            logger.debug("Received message: %s", content)
            t = content.get("type")
            user_id = self.scope["user"].id
            engine = ENGINES.get(self.room_code)

            if t == "play":
                if engine is None:
                    await self.send_json({"error": "game-not-started"})
                    return

                pending_collect_for_user = engine.pending_collect and engine.collect_winner == user_id
                if engine.winner is not None and engine.winner != user_id:
                    await self.send_json({"error": "game-over"})
                    return

                if not pending_collect_for_user:
                    hand = engine.hands.get(user_id)
                    if not hand:
                        await self.send_json({"error": "no-cards"})
                        return

                res = engine.play_card(user_id)
                last_action = {
                    "type": "play",
                    "res": res,
                    "collected": res.get("collected", False),
                }
                winner = engine.winner
                extra = {"lastAction": last_action}
                if winner is not None:
                    last_action["winner"] = winner
                    extra["winner"] = winner
                await self._broadcast_state(extra=extra)

            elif t == "slap":
                ts = time.time_ns()
                if not engine.is_slap_valid():
                    res = engine.slap(user_id)
                    await self._broadcast_state(extra={
                        "lastAction": {
                            "type": "slap_invalid",
                            "userId": user_id,
                            "res": res
                        }
                    })
                    return

                ctx = await self._ensure_slap_ctx()
                async with ctx["lock"]:
                    if not ctx["open"]:
                        ctx["open"] = True
                        ctx["candidates"] = [(ts, user_id)]
                        ctx["task"] = asyncio.create_task(self._resolve_slap_after_delay())
                    else:
                        ctx["candidates"].append((ts, user_id))

                await self._broadcast_state(extra={
                    "lastAction": {"type": "slap_pending"},
                    "graceMs": GRACE_MS
                })

            elif t == "ready":
                value = content.get("value", False)
                await self._set_ready(user_id, value)
                ready_set = READY.setdefault(self.room_code, set())
                if value:
                    ready_set.add(user_id)
                else:
                    ready_set.discard(user_id)
                await self._broadcast_state()

            elif t == "start":
                if await self._is_host(user_id):
                    players = await self._players_order()
                    if len(players) < 2:
                        await self.send_json({"error": "not-enough-players"})
                        return
                    try:
                        if await self._all_players_ready():
                            await self._reset_engine(clear_ready=True)
                            await self._set_room_started()
                            await self._reset_ready_flags()
                            await self._broadcast_state()
                        else:
                            await self.send_json({"error": "not-ready"})
                    except Exception:
                        await self.send_json({"error": "start-failed"})
            elif t == "stop":
                if await self._is_host(user_id):
                    await self._set_room_stopped()
                    await self._reset_engine(clear_ready=True)
                    await self._reset_ready_flags()
                    await self._broadcast_state()
            elif t == "restart":
                if await self._is_host(user_id):
                    await self._set_room_stopped()
                    await self._reset_engine(clear_ready=True)
                    await self._reset_ready_flags()
                    await self._broadcast_state()
            else:
                await self.send_json({"error": "unknown-event"})
        except Exception:
            logger.exception("Error in receive_json")

    async def disconnect(self, code):
        try:
            logger.debug("Disconnecting room %s", getattr(self, "room_code", None))
            await self.channel_layer.group_discard(self.group, self.channel_name)
            ready = READY.get(self.room_code)
            uid = getattr(self, "user_id", None)
            if uid is None and self.scope.get("user"):
                uid = self.scope.get("user").id
            broadcast_needed = False
            reset_required = False
            room_deleted = False
            final_connection = False
            key = getattr(self, "_connection_key", None)
            if key is None and uid is not None:
                key = (self.room_code, uid)
            if key is not None:
                current = CONNECTION_COUNTS.get(key, 0)
                if current <= 1:
                    final_connection = True
                    CONNECTION_COUNTS.pop(key, None)
                else:
                    CONNECTION_COUNTS[key] = current - 1
            if final_connection:
                self._connection_key = None
                if ready and uid:
                    if uid in ready:
                        broadcast_needed = True
                    ready.discard(uid)
                if uid:
                    result = await self._remove_player_and_update_room(uid)
                    if isinstance(result, tuple):
                        removed_player, room_deleted = result
                    else:
                        removed_player = result
                    if removed_player:
                        if not room_deleted:
                            reset_required = True
                            broadcast_needed = True
                if reset_required:
                    await self._reset_ready_flags()
                    await self._reset_engine(clear_ready=True)
                if broadcast_needed:
                    extra = {"playerLeft": uid} if uid else None
                    await self._broadcast_state(extra=extra)
            group = getattr(self.channel_layer, "groups", {}).get(self.group)
            if not group:
                engine = ENGINES.pop(self.room_code, None)
                if engine and not room_deleted:
                    await self._persist_state(engine)
                ctx = SLAP_CTX.pop(self.room_code, None)
                if ctx and ctx.get("task"):
                    ctx["task"].cancel()
                READY.pop(self.room_code, None)
                stale_keys = [key for key in CONNECTION_COUNTS if key[0] == self.room_code]
                for stale_key in stale_keys:
                    CONNECTION_COUNTS.pop(stale_key, None)
        except Exception:
            logger.exception("Error in disconnect")

    async def _resolve_slap_after_delay(self):
        await asyncio.sleep(GRACE_MS / 1000.0)
        engine = ENGINES.get(self.room_code)
        ctx = SLAP_CTX[self.room_code]
        async with ctx["lock"]:
            candidates = ctx.get("candidates", [])
            ctx["open"] = False
            ctx["task"] = None

        if not candidates:
            await self._broadcast_state(extra={"lastAction": {"type": "slap_none"}})
            return

        # If a player taps multiple times within the grace period, the server can
        # receive duplicate entries for that user in ``candidates``.  Deduplicate
        # by user ID while keeping the earliest timestamp for each player so the
        # leaderboard reflects each participant only once.
        dedup = {}
        for ts, uid in candidates:
            if uid not in dedup or ts < dedup[uid]:
                dedup[uid] = ts
        deduped = sorted(((ts, uid) for uid, ts in dedup.items()), key=lambda x: (x[0], x[1]))
        winner_ts, winner_id = deduped[0]
        engine.resolve_slap(winner_id)
        pretty = [{"userId": uid, "t_ns": ts} for ts, uid in deduped]
        last_action = {
            "type": "slap_resolved",
            "winner": {"userId": winner_id, "t_ns": winner_ts},
            "candidates": pretty,
        }
        game_winner = engine.winner
        extra = {"lastAction": last_action}
        if game_winner is not None:
            last_action["gameWinner"] = game_winner
            extra["winner"] = game_winner
        await self._broadcast_state(extra=extra)

    async def _ensure_slap_ctx(self):
        if self.room_code not in SLAP_CTX:
            SLAP_CTX[self.room_code] = {"open": False, "candidates": [], "task": None, "lock": asyncio.Lock()}
        return SLAP_CTX[self.room_code]

    async def _broadcast_state(self, extra=None):
        engine = ENGINES.get(self.room_code)
        raw_players = await self._players_info()
        players = [
            {"userId": p["user_id"], "username": p["user__username"]}
            for p in raw_players
        ]
        host_id = await self._get_host_id()
        payload = {
            "type": "state",
            "players": players,
            "ready": list(READY.get(self.room_code, set())),
            "hostId": host_id,
        }
        payload["started"] = await self._is_started()
        if engine is None:
            payload["pending"] = "waiting_for_players"
        else:
            state = engine.serialize()
            payload["state"] = state
            winner = state.get("winner")
            if winner is not None:
                payload.setdefault("winner", winner)
        if extra:
            payload.update(extra)
        await self.channel_layer.group_send(self.group, {"type": "deliver", "payload": payload})

    async def deliver(self, event):
        await self.send_json(event["payload"])

    async def refresh_state(self, event):
        await self._reset_engine(clear_ready=False)
        await self._broadcast_state()

    async def player_joined(self, event):
        await self._broadcast_state()

    async def _ensure_engine(self):
        if self.room_code not in ENGINES:
            players = await self._players_order()
            if not players:  # pas encore de joueurs -> ne pas créer le moteur
                ENGINES[self.room_code] = None
                return
            ENGINES[self.room_code] = GameEngine(players)

    async def _reset_engine(self, clear_ready=False):
        players = await self._players_order()
        if players:
            ENGINES[self.room_code] = GameEngine(players)
        else:
            ENGINES[self.room_code] = None
        if clear_ready:
            READY[self.room_code] = set()

    @database_sync_to_async
    def _remove_player_and_update_room(self, user_id):
        try:
            room = Room.objects.get(code=self.room_code)
        except Room.DoesNotExist:
            return False, False

        try:
            player = Player.objects.get(room=room, user_id=user_id)
        except Player.DoesNotExist:
            return False, False

        seat = player.seat
        player.delete()

        if not room.players.exists():
            room.delete()
            return True, True

        update_fields = ["is_started"]
        room.is_started = False

        if room.host_id == user_id:
            base_qs = room.players.order_by("seat").select_related("user")
            next_player = base_qs.filter(seat__gt=seat).first()
            if not next_player:
                next_player = base_qs.first()
            if next_player:
                room.host = next_player.user
                update_fields.append("host")

        room.save(update_fields=update_fields)
        return True, False

    @database_sync_to_async
    def _persist_state(self, engine):
        room = Room.objects.get(code=self.room_code)
        GameState.objects.update_or_create(
            room=room,
            defaults={"state_json": engine.serialize()},
        )

    @database_sync_to_async
    def _get_host_id(self):
        try:
            room = Room.objects.only("host_id").get(code=self.room_code)
        except Room.DoesNotExist:
            return None
        return room.host_id

    @database_sync_to_async
    def _is_host(self, user_id):
        r = Room.objects.get(code=self.room_code)
        return r.host_id == user_id

    @database_sync_to_async
    def _is_started(self):
        r = Room.objects.get(code=self.room_code)
        return r.is_started

    @database_sync_to_async
    def _players_order(self):
        r = Room.objects.get(code=self.room_code)
        return list(r.players.order_by("seat").values_list("user_id", flat=True))

    @database_sync_to_async
    def _players_info(self):
        r = Room.objects.get(code=self.room_code)
        return list(
            r.players.order_by("seat").values("user_id", "user__username")
        )

    @database_sync_to_async
    def _set_ready(self, user_id, value):
        Player.objects.filter(room__code=self.room_code, user_id=user_id).update(is_ready=value)

    @database_sync_to_async
    def _reset_ready_flags(self):
        Player.objects.filter(room__code=self.room_code).update(is_ready=False)

    @database_sync_to_async
    def _all_players_ready(self):
        return not Player.objects.filter(room__code=self.room_code, is_ready=False).exists()

    @database_sync_to_async
    def _set_room_started(self):
        room = Room.objects.get(code=self.room_code)
        room.is_started = True
        room.save(update_fields=["is_started"])

    @database_sync_to_async
    def _set_room_stopped(self):
        room = Room.objects.get(code=self.room_code)
        room.is_started = False
        room.save(update_fields=["is_started"])

    @database_sync_to_async
    def _is_room_started(self):
        return Room.objects.filter(code=self.room_code, is_started=True).exists()
