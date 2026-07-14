from ..base import GameSpec
from .engine import UnPourCentEngine

SPEC = GameSpec(
    game_type="1_percent",
    label="Le 1%",
    engine_class=UnPourCentEngine,
    room_template="game/room_un_pourcent.html",
    realtime_slap=False,
    per_user_state=True,
    icon="💰",
    order=20,
)
