from ..base import GameSpec
from .engine import GameEngine

SPEC = GameSpec(
    game_type="bataille_corse",
    label="Bataille Corse",
    engine_class=GameEngine,
    room_template="game/room.html",
    realtime_slap=True,
    icon="🃏",
    order=10,
)
