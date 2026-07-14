"""Registre des jeux.

Point d'entrée unique pour résoudre, à partir d'un ``game_type``, le moteur et
les métadonnées d'un jeu. Ajouter un jeu = créer un sous-paquet avec un module
``spec`` exposant ``SPEC`` puis l'enregistrer ici. Aucun autre jeu n'est touché.
"""

from .base import BaseGameEngine, GameSpec

DEFAULT_GAME_TYPE = "bataille_corse"

_REGISTRY: dict[str, GameSpec] = {}


def register(spec: GameSpec) -> GameSpec:
    _REGISTRY[spec.game_type] = spec
    return spec


def all_specs():
    """Toutes les specs, triées pour un affichage stable (lobby, choix)."""
    return sorted(_REGISTRY.values(), key=lambda s: (s.order, s.label))


def get_spec(game_type) -> GameSpec:
    """Spec du jeu demandé, avec repli sur le jeu par défaut."""
    return _REGISTRY.get(game_type) or _REGISTRY[DEFAULT_GAME_TYPE]


def get_engine_class(game_type):
    return get_spec(game_type).engine_class


def game_choices():
    """``choices`` prêtes pour le champ ``Room.game_type``."""
    return [(spec.game_type, spec.label) for spec in all_specs()]


# --- Enregistrement des jeux intégrés -------------------------------------
# Import après la définition de ``register`` pour éviter tout import circulaire.
from .bataille_corse.spec import SPEC as _BATAILLE_CORSE_SPEC  # noqa: E402
from .un_pourcent.spec import SPEC as _UN_POURCENT_SPEC  # noqa: E402

register(_BATAILLE_CORSE_SPEC)
register(_UN_POURCENT_SPEC)

__all__ = [
    "BaseGameEngine",
    "GameSpec",
    "DEFAULT_GAME_TYPE",
    "register",
    "all_specs",
    "get_spec",
    "get_engine_class",
    "game_choices",
]
