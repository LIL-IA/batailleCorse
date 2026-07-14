"""Cartes spécifiques du jeu « Le 1% ».

Trois paquets distincts, plus les dés :

* **Pioche** (50 cartes) : 5 catégories × valeurs 1 à 5, en 2 exemplaires.
  Ces cartes forment les mains cachées sur lesquelles portent les enchères.
* **Récompenses** (40 cartes) : cartes numérotées 1 à 9. Chaque numéro acquis
  débloque un chiffre gagnant supplémentaire pour les lancers de dés.
* **Bonus** (21 cartes) : pouvoirs spéciaux (relance d'un dé, pioche de 2
  récompenses, vol d'une carte à un joueur), 7 de chaque.

Récompenses et Bonus sont mélangés dans un même paquet dont on retourne 3 cartes
au centre de la table.

Représentation : chaque carte est un ``dict`` sérialisable JSON, discriminé par
sa clé ``kind`` (``"draw"`` / ``"reward"`` / ``"bonus"``). C'est un espace de
noms propre au 1% : il n'interfère avec aucun autre jeu.
"""

# --- Catégories de la pioche ------------------------------------------------
# (clé, libellé FR, emoji) — utilisées aussi côté interface.
CATEGORIES = [
    ("shark", "Requin", "🦈"),
    ("lightning", "Éclair", "⚡"),
    ("clover", "Trèfle", "🍀"),
    ("star", "Étoile", "⭐"),
    ("comet", "Comète", "☄️"),
]
CATEGORY_KEYS = [key for key, _label, _icon in CATEGORIES]
CATEGORY_LABELS = {key: label for key, label, _icon in CATEGORIES}
CATEGORY_ICONS = {key: icon for key, _label, icon in CATEGORIES}

DRAW_VALUES = [1, 2, 3, 4, 5]
DRAW_COPIES = 2  # 5 catégories × 5 valeurs × 2 = 50 cartes

# --- Cartes Récompense ------------------------------------------------------
# 40 cartes réparties sur les numéros 1 à 9 (numéros bas plus fréquents).
REWARD_DISTRIBUTION = {1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 4, 7: 4, 8: 4, 9: 3}

# --- Cartes Bonus -----------------------------------------------------------
# (clé du pouvoir, libellé FR, emoji)
BONUS_POWERS = [
    ("reroll", "Relance d'un dé", "🎲"),
    ("draw2", "Pioche 2 récompenses", "🃏"),
    ("steal", "Vol d'une carte", "🫳"),
]
BONUS_LABELS = {key: label for key, label, _icon in BONUS_POWERS}
BONUS_ICONS = {key: icon for key, _label, icon in BONUS_POWERS}
BONUS_COPIES = 7  # 3 pouvoirs × 7 = 21 cartes

# --- Dés --------------------------------------------------------------------
D10_FACES = list(range(10))  # deux dés à 10 faces : 0 à 9
BASE_WINNING_NUMBER = 0  # tout le monde possède le « 0 » de départ (le « 00 »)


def build_draw_pile():
    """La pioche : 50 cartes de catégorie."""
    pile = []
    for category in CATEGORY_KEYS:
        for value in DRAW_VALUES:
            for _ in range(DRAW_COPIES):
                pile.append({"kind": "draw", "category": category, "value": value})
    return pile


def build_reward_bonus_pile():
    """Le paquet central mélangé : 40 récompenses + 21 bonus (61 cartes)."""
    pile = []
    for value, count in REWARD_DISTRIBUTION.items():
        for _ in range(count):
            pile.append({"kind": "reward", "value": value})
    for power, _label, _icon in BONUS_POWERS:
        for _ in range(BONUS_COPIES):
            pile.append({"kind": "bonus", "power": power})
    return pile


# Contrôles de cohérence (documentent les totaux annoncés dans les règles).
assert len(build_draw_pile()) == 50
assert sum(REWARD_DISTRIBUTION.values()) == 40
assert len(build_reward_bonus_pile()) == 40 + 21
