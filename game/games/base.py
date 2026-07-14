"""Contrats communs, agnostiques du jeu, partagés par tous les modules de jeu.

Chaque jeu vit dans son propre sous-paquet (``game/games/<jeu>/``) et fournit :

* un moteur qui hérite de :class:`BaseGameEngine` (règles + état sérialisable) ;
* une :class:`GameSpec` déclarant comment le brancher (libellé, template,
  interface temps réel ou tour par tour…).

Le consommateur WebSocket et les vues ne connaissent que ces deux contrats :
ajouter un jeu n'impacte donc aucun autre jeu.
"""

from dataclasses import dataclass
from typing import Type


class BaseGameEngine:
    """Interface minimale sur laquelle s'appuie ``RoomConsumer`` pour tout jeu.

    Les jeux tour par tour (comme « Le 1% ») implémentent
    :meth:`handle_action`. Les jeux temps réel à réflexe (comme la Bataille
    Corse) court-circuitent ce point d'entrée et gèrent leurs propres messages
    dans le consommateur, mais partagent tout de même la gestion des options.
    """

    #: Options par défaut du jeu (schéma propre à chaque jeu).
    DEFAULT_OPTIONS: dict = {}

    # ------------------------------------------------------------------ options
    @classmethod
    def default_options(cls):
        return dict(cls.DEFAULT_OPTIONS)

    @classmethod
    def sanitize_options(cls, overrides=None, base=None):
        """Fusionne ``base`` puis ``overrides`` par-dessus les valeurs par défaut.

        Implémentation générique volontairement simple : chaque jeu peut la
        surcharger pour valider/normaliser finement ses propres options.
        """
        result = cls.default_options()
        for source in (base, overrides):
            if isinstance(source, dict):
                for key in result:
                    if key in source:
                        result[key] = source[key]
        return result

    @classmethod
    def normalize_legacy_options(cls, source):
        """Migre d'anciennes clés d'options.

        Retourne ``(source_normalisée, converti?)``. Par défaut : aucun héritage
        à convertir. La Bataille Corse surcharge pour migrer ``penalty_mode``.
        """
        if isinstance(source, dict):
            return dict(source), False
        return source, False

    @classmethod
    def options_cache_current(cls, cached):
        """Indique si un cache d'options est encore au bon format (sinon on
        le régénère). Par défaut : tout dictionnaire convient."""
        return isinstance(cached, dict)

    # --------------------------------------------------------------- cycle de vie
    def __init__(self, players, options=None):
        self.players = list(players)
        self.options = self.sanitize_options(base=options)

    def set_options(self, options):
        self.options = self.sanitize_options(base=options)
        return self.options

    def update_options(self, overrides):
        self.options = self.sanitize_options(overrides=overrides, base=self.options)
        return self.options

    def serialize(self, mask_for=None):  # pragma: no cover - contrat abstrait
        raise NotImplementedError

    # --------------------------------------------------------------- actions jeu
    def handle_action(self, user_id, content):
        """Point d'entrée des actions pour les jeux tour par tour.

        ``content`` est le message WebSocket brut. Retourne un dict ; une clé
        ``error`` signale un refus. Les jeux temps réel n'utilisent pas ce point
        d'entrée.
        """
        return {"error": "unknown-action"}


@dataclass(frozen=True)
class GameSpec:
    """Décrit un jeu et comment le brancher dans l'application."""

    game_type: str
    label: str
    engine_class: Type[BaseGameEngine]
    room_template: str
    #: True => interface temps réel « tape » gérée par le consommateur (Bataille
    #: Corse). False => actions tour par tour déléguées à ``engine.handle_action``.
    realtime_slap: bool = False
    icon: str = "🎮"
    #: Sert à ordonner les jeux dans les listes (lobby, choix du modèle).
    order: int = 100
