import time
import asyncio
import logging
from collections import defaultdict
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from .models import Room, GameState, Player
from .engine import GameEngine, PENALTY_MODE_SUDDEN_DEATH, PENALTY_SUDDEN_DEATH_MAP

logger = logging.getLogger(__name__)

ENGINES = {}
SLAP_CTX = {}
READY = {}
ROOM_OPTIONS = {}
CONNECTION_COUNTS = defaultdict(int)
ROOM_CONNECTION_COUNTS = defaultdict(int)
PENDING_FINAL_DISCONNECTS = {}
# Delay before performing the final disconnect cleanup to allow quick refreshes
FINAL_DISCONNECT_DELAY_SECONDS = 2
# Delay in milliseconds to collect all slap candidates before resolving
GRACE_MS = 1000
SUDDEN_DEATH_KEYS = set(PENALTY_SUDDEN_DEATH_MAP.values())

class RoomConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        try:
            self.room_code = self.scope['url_route']['kwargs']['room_code']
            self.group = f"room_{self.room_code}"
            user = self.scope.get("user")
            if isinstance(user, AnonymousUser) or not user.is_authenticated:
                await self.close()
                return
            self.user_id = user.id
            self._connection_key = (self.room_code, self.user_id)
            await self._cancel_pending_final_disconnect(self._connection_key)
            await self.channel_layer.group_add(self.group, self.channel_name)
            await self.accept()
            CONNECTION_COUNTS[self._connection_key] += 1
            ROOM_CONNECTION_COUNTS[self.room_code] += 1
            self._room_connection_tracked = True
            READY.setdefault(self.room_code, set())
            if await self._is_room_started():
                await self._ensure_engine()
            else:
                ENGINES[self.room_code] = None
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

            if t in {"play", "slap"} and not await self._is_started():
                await self.send_json({"error": "game-not-started"})
                return

            if t == "play":
                if engine is None:
                    await self.send_json({"error": "game-not-started"})
                    return

                pending_collect_for_user = engine.pending_collect and engine.collect_winner == user_id
                
                # Rule check: If a slap rule is active, intercept the collection and route to slap race
                if pending_collect_for_user and engine.is_slap_valid():
                    t = "slap"
                else:
                    if engine.winner is not None and engine.winner != user_id:
                        await self.send_json({"error": "game-over"})
                        return

                    ctx = await self._ensure_slap_ctx()
                    async with ctx["lock"]:
                        if ctx["open"]:
                            await self.send_json({"error": "slap-in-progress"})
                            return

                    if not pending_collect_for_user:
                        hand = engine.hands.get(user_id)
                        if not hand:
                            await self.send_json({"error": "no-cards"})
                            return

                    # Normal play card or normal collection button click
                    res = engine.play_card(user_id)
                    
                    if res.get("ok") and "card" in res:
                        ctx = await self._ensure_slap_ctx()
                        async with ctx["lock"]:
                            ctx["last_card_ns"] = time.time_ns()
                            
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
                    return  # Fast-exit

            if t == "slap":
                ts = time.time_ns()
                ctx = await self._ensure_slap_ctx()

                # Le gagnant légitime du défi de figure qui tape sur le tas le
                # ramasse normalement, sans animation ni course au slap — tant
                # qu'aucune tentative de vol n'est déjà en cours. La course (et
                # donc l'animation) ne se déclenche que si d'autres joueurs
                # tentent de lui voler le pli avant qu'il ne ramasse.
                if engine.pending_collect and engine.collect_winner == user_id:
                    async with ctx["lock"]:
                        steal_in_progress = ctx["open"]
                    if not steal_in_progress:
                        res = engine.play_card(user_id)
                        await self._broadcast_state(extra={
                            "lastAction": {
                                "type": "play",
                                "res": res,
                                "collected": True
                            }
                        })
                        return

                if not engine.is_slap_valid():
                    # Real invalid slap penalty
                    res = engine.slap(user_id)
                    await self._broadcast_state(extra={
                        "lastAction": {
                            "type": "slap_invalid",
                            "userId": user_id,
                            "res": res
                        }
                    })
                    return

                async with ctx["lock"]:
                    baseline_ns = ctx.get("last_card_ns")
                    reaction_ns = None
                    if isinstance(baseline_ns, int):
                        reaction_ns = ts - baseline_ns
                        if reaction_ns < 0:
                            reaction_ns = 0
                    candidate = {"ts": ts, "user_id": user_id, "reaction_ns": reaction_ns}
                    if not ctx["open"]:
                        ctx["open"] = True
                        ctx["candidates"] = [candidate]
                        ctx["task"] = asyncio.create_task(self._resolve_slap_after_delay())
                    else:
                        ctx["candidates"].append(candidate)

                await self._broadcast_state(extra={
                    "lastAction": {"type": "slap_pending"},
                    "graceMs": GRACE_MS
                })
                return # Fast-exit

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
            elif t in {"update_rules", "set_options"}:
                if not await self._is_host(user_id):
                    await self.send_json({"error": "not-host"})
                    return
                if await self._is_started():
                    await self.send_json({"error": "game-started"})
                    return
                raw_options = content.get("options")
                if not isinstance(raw_options, dict):
                    await self.send_json({"error": "invalid-options"})
                    return
                await self._update_room_rules(raw_options)
                await self._broadcast_state()
            elif t == "preview_game_type":
                if not await self._is_host(user_id):
                    await self.send_json({"error": "not-host"})
                    return
                if await self._is_started():
                    await self.send_json({"error": "game-started"})
                    return
                game_type = content.get("game_type")
                valid_types = [choice[0] for choice in Room.GAME_CHOICES]
                if game_type not in valid_types:
                    await self.send_json({"error": "invalid-game-type"})
                    return
                await self._update_room_game_type(game_type)
                await self.channel_layer.group_send(
                    self.group,
                    {
                        "type": "game_type_changed",
                        "game_type": game_type,
                    }
                )
            elif t == "validate_game":
                if not await self._is_host(user_id):
                    await self.send_json({"error": "not-host"})
                    return
                if await self._is_started():
                    await self.send_json({"error": "game-started"})
                    return
                game_type = content.get("game_type")
                valid_types = [choice[0] for choice in Room.GAME_CHOICES]
                if game_type not in valid_types:
                    await self.send_json({"error": "invalid-game-type"})
                    return
                await self._update_room_game_type(game_type)
                await self._validate_room_game()
                await self.channel_layer.group_send(
                    self.group,
                    {
                        "type": "game_validated",
                        "game_type": game_type,
                    }
                )
            else:
                await self.send_json({"error": "unknown-event"})
        except Exception as e:
            logger.exception("Error in receive_json")
            await self.send_json({"error": "server-error", "details": str(e)})

    async def disconnect(self, code):
        try:
            logger.debug("Disconnecting room %s", getattr(self, "room_code", None))
            await self.channel_layer.group_discard(self.group, self.channel_name)
            uid = getattr(self, "user_id", None)
            if uid is None and self.scope.get("user"):
                uid = self.scope.get("user").id
            room_code = getattr(self, "room_code", None)
            room_empty = False
            if room_code:
                if getattr(self, "_room_connection_tracked", False):
                    room_connections = ROOM_CONNECTION_COUNTS.get(room_code, 0)
                    if room_connections <= 1:
                        ROOM_CONNECTION_COUNTS.pop(room_code, None)
                        room_empty = True
                    else:
                        ROOM_CONNECTION_COUNTS[room_code] = room_connections - 1
                else:
                    room_empty = room_code not in ROOM_CONNECTION_COUNTS
            final_connection = False
            key = getattr(self, "_connection_key", None)
            if key is None and uid is not None:
                key = (room_code, uid)
            if key is not None:
                current = CONNECTION_COUNTS.get(key, 0)
                if current <= 1:
                    final_connection = True
                    CONNECTION_COUNTS.pop(key, None)
                else:
                    CONNECTION_COUNTS[key] = current - 1
            if final_connection and room_code and uid is not None:
                self._connection_key = None
                self._schedule_final_disconnect_cleanup(room_code, uid)
            else:
                if final_connection:
                    self._connection_key = None
                    await self._final_disconnect_cleanup(room_code, uid)
                elif room_empty:
                    await self._final_disconnect_cleanup(room_code, uid)
        except Exception:
            logger.exception("Error in disconnect")

    async def _resolve_slap_after_delay(self):
        await asyncio.sleep(GRACE_MS / 1000.0)
        engine = ENGINES.get(self.room_code)
        ctx = SLAP_CTX[self.room_code]
        async with ctx["lock"]:
            candidates = list(ctx.get("candidates", []))
            baseline_ns = ctx.get("last_card_ns")
            ctx["open"] = False
            ctx["task"] = None
            ctx["candidates"] = []

        if not candidates:
            await self._broadcast_state(extra={"lastAction": {"type": "slap_none"}})
            return

        # If a player taps multiple times within the grace period, the server can
        # receive duplicate entries for that user in ``candidates``.  Deduplicate
        # by user ID while keeping the earliest timestamp for each player so the
        # leaderboard reflects each participant only once.
        dedup = {}
        for candidate in candidates:
            if isinstance(candidate, dict):
                ts = candidate.get("ts")
                uid = candidate.get("user_id")
                reaction_ns = candidate.get("reaction_ns")
            else:
                try:
                    ts, uid = candidate
                except (TypeError, ValueError):
                    continue
                reaction_ns = None
            if ts is None or uid is None:
                continue
            try:
                ts_int = int(ts)
            except (TypeError, ValueError):
                continue
            existing = dedup.get(uid)
            if existing is None or ts_int < existing["ts"]:
                dedup[uid] = {"ts": ts_int, "reaction_ns": reaction_ns}

        if not dedup:
            await self._broadcast_state(extra={"lastAction": {"type": "slap_none"}})
            return

        deduped_entries = [
            (data["ts"], uid, data.get("reaction_ns")) for uid, data in dedup.items()
        ]
        deduped_entries.sort(key=lambda item: (item[0], item[1]))
        winner_ts, winner_id, winner_reaction_ns = deduped_entries[0]

        def normalized_reaction(ts_value, reaction_value):
            if reaction_value is None and isinstance(baseline_ns, int):
                reaction_value = ts_value - baseline_ns
            if reaction_value is None:
                return None
            try:
                reaction_int = int(reaction_value)
            except (TypeError, ValueError):
                return None
            if reaction_int < 0:
                reaction_int = 0
            return reaction_int

        engine.resolve_slap(winner_id)
        pretty = []
        for ts, uid, reaction_ns in deduped_entries:
            entry = {"userId": uid, "t_ns": ts}
            normalized = normalized_reaction(ts, reaction_ns)
            if normalized is not None:
                entry["reaction_ns"] = normalized
            pretty.append(entry)

        winner_reaction = normalized_reaction(winner_ts, winner_reaction_ns)
        last_action = {
            "type": "slap_resolved",
            "winner": {"userId": winner_id, "t_ns": winner_ts},
            "candidates": pretty,
        }
        if winner_reaction is not None:
            last_action["winner"]["reaction_ns"] = winner_reaction
        if isinstance(baseline_ns, int):
            last_action["baselineNs"] = baseline_ns
        game_winner = engine.winner
        extra = {"lastAction": last_action}
        if game_winner is not None:
            last_action["gameWinner"] = game_winner
            extra["winner"] = game_winner
        await self._broadcast_state(extra=extra)

    async def _ensure_slap_ctx(self):
        ctx = SLAP_CTX.get(self.room_code)
        if ctx is None:
            ctx = {
                "open": False,
                "candidates": [],
                "task": None,
                "lock": asyncio.Lock(),
                "last_card_ns": None,
            }
            SLAP_CTX[self.room_code] = ctx
        else:
            ctx.setdefault("last_card_ns", None)
        return ctx

    async def _get_options(self):
        cached = ROOM_OPTIONS.get(self.room_code)
        if cached is not None and self._options_cache_current(cached):
            return dict(cached)
        raw = await self._load_room_options()
        normalized, legacy_converted = self._normalize_legacy_penalty_flags(raw)
        sanitized = GameEngine.sanitize_options(base=normalized)
        ROOM_OPTIONS[self.room_code] = dict(sanitized)
        if self._should_persist_options(raw, sanitized, legacy_converted):
            await self._save_room_options(sanitized)
        return dict(sanitized)

    async def _update_room_rules(self, overrides):
        current = await self._get_options()
        normalized_overrides, _ = self._normalize_legacy_penalty_flags(overrides)
        sanitized = GameEngine.sanitize_options(overrides=normalized_overrides, base=current)
        if sanitized != current:
            await self._save_room_options(sanitized)
            ROOM_OPTIONS[self.room_code] = dict(sanitized)
            engine = ENGINES.get(self.room_code)
            if engine:
                engine.set_options(sanitized)
        return sanitized

    @staticmethod
    def _options_cache_current(cached):
        if not isinstance(cached, dict):
            return False
        if "penalty_mode" in cached:
            return False
        return SUDDEN_DEATH_KEYS.issubset(cached.keys())

    def _normalize_legacy_penalty_flags(self, source):
        if not isinstance(source, dict):
            return source, False
        updated = dict(source)
        if "penalty_mode" not in updated:
            return updated, False
        legacy_mode = GameEngine._normalize_penalty_mode(updated.pop("penalty_mode"))
        is_sudden_death = legacy_mode == PENALTY_MODE_SUDDEN_DEATH
        for sudden_key in SUDDEN_DEATH_KEYS:
            updated.setdefault(sudden_key, is_sudden_death)
        return updated, True

    @staticmethod
    def _should_persist_options(raw, sanitized, legacy_converted):
        if not isinstance(raw, dict) or not raw:
            return False
        if legacy_converted:
            return True
        for key, value in raw.items():
            if key not in sanitized:
                continue
            sanitized_value = sanitized[key]
            if sanitized_value != value or type(sanitized_value) != type(value):
                return True
        return False

    async def _broadcast_state(self, extra=None):
        engine = ENGINES.get(self.room_code)
        raw_players = await self._players_info()
        players = [
            {"userId": p["user_id"], "username": p["user__username"]}
            for p in raw_players
        ]
        host_id = await self._get_host_id()
        sanitized_options = await self._get_options()
        game_type = await self._get_game_type()

        payload = {
            "type": "state",
            "players": players,
            "ready": list(READY.get(self.room_code, set())),
            "hostId": host_id,
            "options": sanitized_options,
            "gameType": game_type,
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

    async def state(self, event):
        await self.send_json(event)

    async def game_type_changed(self, event):
        await self.send_json({
            "type": "game_type_changed",
            "game_type": event["game_type"]
        })

    async def game_validated(self, event):
        await self.send_json({
            "type": "game_validated",
            "game_type": event["game_type"]
        })

    async def refresh_state(self, event):
        await self._reset_engine(clear_ready=False)
        await self._broadcast_state()

    async def player_joined(self, event):
        await self._broadcast_state()

    async def _ensure_engine(self):
        if self.room_code not in ENGINES:
            players = await self._players_order()
            options = await self._get_options()
            if not players:  # pas encore de joueurs -> ne pas créer le moteur
                ENGINES[self.room_code] = None
                return
            ENGINES[self.room_code] = GameEngine(players, options=options)

    async def _reset_engine(self, clear_ready=False):
        players = await self._players_order()
        options = await self._get_options()
        if players:
            ENGINES[self.room_code] = GameEngine(players, options=options)
        else:
            ENGINES[self.room_code] = None
        if clear_ready:
            READY[self.room_code] = set()

    def _schedule_final_disconnect_cleanup(self, room_code, user_id):
        key = (room_code, user_id)
        task = asyncio.create_task(self._final_disconnect_after_delay(room_code, user_id))
        PENDING_FINAL_DISCONNECTS[key] = task

    async def _final_disconnect_after_delay(self, room_code, user_id):
        key = (room_code, user_id)
        task = asyncio.current_task()
        try:
            await asyncio.sleep(FINAL_DISCONNECT_DELAY_SECONDS)
            if CONNECTION_COUNTS.get(key, 0):
                return
            await self._final_disconnect_cleanup(room_code, user_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error during delayed final disconnect cleanup for room %s", room_code)
        finally:
            if task and PENDING_FINAL_DISCONNECTS.get(key) is task:
                PENDING_FINAL_DISCONNECTS.pop(key, None)

    async def _cancel_pending_final_disconnect(self, key):
        if key is None:
            return
        task = PENDING_FINAL_DISCONNECTS.get(key)
        if not task:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error while cancelling pending final disconnect for %s", key)
        finally:
            if PENDING_FINAL_DISCONNECTS.get(key) is task:
                PENDING_FINAL_DISCONNECTS.pop(key, None)

    async def _final_disconnect_cleanup(self, room_code, user_id):
        broadcast_needed = False
        reset_required = False
        room_deleted = False
        ready = READY.get(room_code)
        if ready and user_id is not None:
            if user_id in ready:
                broadcast_needed = True
            ready.discard(user_id)
        if user_id is not None:
            result = await self._remove_player_and_update_room(user_id)
            if isinstance(result, tuple):
                removed_player, room_deleted = result
            else:
                removed_player = result
            if removed_player and not room_deleted:
                reset_required = True
                broadcast_needed = True
        if reset_required:
            await self._reset_ready_flags()
            await self._reset_engine(clear_ready=True)
        if broadcast_needed:
            extra = {"playerLeft": user_id} if user_id is not None else None
            await self._broadcast_state(extra=extra)

        room_empty = ROOM_CONNECTION_COUNTS.get(room_code, 0) <= 0
        if room_empty:
            engine = ENGINES.pop(room_code, None)
            if engine and not room_deleted:
                await self._persist_state(engine)
            ctx = SLAP_CTX.pop(room_code, None)
            if ctx and ctx.get("task"):
                ctx["task"].cancel()
            READY.pop(room_code, None)
            ROOM_OPTIONS.pop(room_code, None)
            stale_keys = [key for key in list(CONNECTION_COUNTS) if key[0] == room_code]
            for stale_key in stale_keys:
                CONNECTION_COUNTS.pop(stale_key, None)

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
    def _load_room_options(self):
        try:
            room = Room.objects.only("rules_options").get(code=self.room_code)
        except Room.DoesNotExist:
            return {}
        return room.rules_options or {}

    @database_sync_to_async
    def _save_room_options(self, options):
        Room.objects.filter(code=self.room_code).update(rules_options=options)

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
    def _get_game_type(self):
        try:
            r = Room.objects.only("game_type").get(code=self.room_code)
            return r.game_type
        except Room.DoesNotExist:
            return "bataille_corse"

    @database_sync_to_async
    def _update_room_game_type(self, game_type):
        room = Room.objects.get(code=self.room_code)
        room.game_type = game_type
        room.save(update_fields=["game_type"])

    @database_sync_to_async
    def _validate_room_game(self):
        room = Room.objects.get(code=self.room_code)
        room.game_selected = True
        room.save(update_fields=["game_selected"])

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
