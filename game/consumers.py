import time
import asyncio
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from .models import Room
from .engine import GameEngine

ENGINES = {}
SLAP_CTX = {}
GRACE_MS = 40

class RoomConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.room_code = self.scope['url_route']['kwargs']['room_code']
        self.group = f"room_{self.room_code}"
        user = self.scope.get("user")
        if isinstance(user, AnonymousUser) or not user.is_authenticated:
            await self.close()
            return
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        await self._ensure_engine()
        await self._ensure_slap_ctx()
        await self._broadcast_state()

    async def receive_json(self, content, **kwargs):
        t = content.get("type")
        user_id = self.scope["user"].id
        engine = ENGINES.get(self.room_code)

        if t == "play":
            res = engine.play_card(user_id)
            await self._broadcast_state(extra={"lastAction": {"type": "play", "res": res}})

        elif t == "slap":
            ts = time.time_ns()
            if not engine.is_slap_valid():
                res = engine.slap(user_id)
                await self._broadcast_state(extra={"lastAction": {"type": "slap_invalid", "res": res}})
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

        elif t == "start":
            if await self._is_host(user_id):
                await self._reset_engine()
                await self._broadcast_state()
        else:
            await self.send_json({"error": "unknown-event"})

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group, self.channel_name)

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

        candidates.sort(key=lambda x: (x[0], x[1]))
        winner_ts, winner_id = candidates[0]
        engine.resolve_slap(winner_id)
        pretty = [{"userId": uid, "t_ns": ts} for ts, uid in candidates]
        await self._broadcast_state(extra={
            "lastAction": {
                "type": "slap_resolved",
                "winner": {"userId": winner_id, "t_ns": winner_ts},
                "candidates": pretty
            }
        })

    async def _ensure_slap_ctx(self):
        if self.room_code not in SLAP_CTX:
            SLAP_CTX[self.room_code] = {"open": False, "candidates": [], "task": None, "lock": asyncio.Lock()}
        return SLAP_CTX[self.room_code]

    async def _broadcast_state(self, extra=None):
        engine = ENGINES.get(self.room_code)
        payload = {"type": "state", "state": engine.serialize()}
        if extra:
            payload.update(extra)
        await self.channel_layer.group_send(self.group, {"type": "deliver", "payload": payload})

    async def deliver(self, event):
        await self.send_json(event["payload"])

    async def _ensure_engine(self):
        if self.room_code not in ENGINES:
            players = await self._players_order()
            ENGINES[self.room_code] = GameEngine(players)

    async def _reset_engine(self):
        players = await self._players_order()
        ENGINES[self.room_code] = GameEngine(players)

    @database_sync_to_async
    def _is_host(self, user_id):
        r = Room.objects.get(code=self.room_code)
        return r.host_id == user_id

    @database_sync_to_async
    def _players_order(self):
        r = Room.objects.get(code=self.room_code)
        return list(r.players.order_by("seat").values_list("user_id", flat=True))
