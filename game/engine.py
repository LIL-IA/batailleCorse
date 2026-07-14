"""Compatibilité ascendante.

Le moteur de la Bataille Corse a été déplacé dans son module dédié
``game.games.bataille_corse.engine`` dans le cadre de la modularisation par jeu.
Ce module conserve les anciens points d'import (``from game.engine import
GameEngine``) utilisés par les tests et le code existant.
"""

from game.games.bataille_corse.engine import (  # noqa: F401
    FACE_PENALTIES,
    GameEngine,
    PENALTY_MODE_FIXED,
    PENALTY_MODE_SUDDEN_DEATH,
    PENALTY_STEPS,
    PENALTY_SUDDEN_DEATH_MAP,
    RANK_VALUE,
    RANKS,
    new_deck,
)

__all__ = [
    "FACE_PENALTIES",
    "GameEngine",
    "PENALTY_MODE_FIXED",
    "PENALTY_MODE_SUDDEN_DEATH",
    "PENALTY_STEPS",
    "PENALTY_SUDDEN_DEATH_MAP",
    "RANK_VALUE",
    "RANKS",
    "new_deck",
]
