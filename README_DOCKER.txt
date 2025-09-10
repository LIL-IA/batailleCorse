Docker Quickstart (Bataille Corse)

Prereqs:
- Windows: Install Docker Desktop and enable WSL2 backend
- Mac/Linux: Docker Desktop / Docker Engine

Steps:
1) Put `docker-compose.yml` and `.env.docker` at the project root (same folder as `manage.py`).
2) Build and start:
   docker compose build
   docker compose up -d
3) Run migrations:
   docker compose exec web python manage.py migrate
4) (Optional) Create admin:
   docker compose exec web python manage.py createsuperuser
5) Open http://localhost:8000/

Notes:
- The `web` service mounts your source code; Django autoreload should work.
- WebSockets go through Redis service.
- Stop everything:
   docker compose down
