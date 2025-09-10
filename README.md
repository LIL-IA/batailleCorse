# Bataille Corse — Starter Django + Channels

Starter minimal pour jouer à **Bataille Corse** en ligne (rooms privées, WebSockets).

## TL;DR

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # puis ajuste les valeurs
python manage.py migrate
python manage.py createsuperuser
# lance un Redis local (ou via Docker)
#   docker run -p 6379:6379 redis:7
python manage.py runserver
```

Ouvre http://127.0.0.1:8000/  
Crée un compte, crée une salle, partage le **code** à tes amis (ils doivent aussi créer un compte et se connecter).

## Déploiement (Render / Railway / Fly.io)

- Provisionne 3 services : **Web** (cette app), **Redis**, **PostgreSQL**.
- Variables d'env :
  - `SECRET_KEY` (long aléatoire)
  - `DEBUG=False`
  - `ALLOWED_HOSTS=ton-domaine.com`
  - `REDIS_URL` (fourni par le service Redis)
  - `DATABASE_URL` (Postgres)
- Commande web : `daphne -b 0.0.0.0 -p 8000 project.asgi:application`
- Statiques : gérées par WhiteNoise.
- Option : mets un proxy (Cloudflare) pour le domaine + HTTPS.

## Règles et variantes

Réglages dans `game/engine.py` (`options`): double, sandwich, pénalité, etc.

## À faire (idées)

- UI plus jolie (cartes, animations)
- Sauvegardes périodiques de `GameState`
- Ratelimiting & anti-spam
- Reconnexion robuste / mobile
- Tests unitaires
