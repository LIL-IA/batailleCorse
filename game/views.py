import random
import string
from django.http import HttpResponseServerError
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from .models import Room, Player, GameState

def _gen_code(n=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=n))


def _gen_unique_code():
    """Generate a room code that is not already used."""
    code = _gen_code()
    while Room.objects.filter(code=code).exists():
        code = _gen_code()
    return code

@login_required
def create_room(request):
    if request.method == "POST":
        for _ in range(10):
            code = _gen_unique_code()
            room, created = Room.objects.get_or_create(
                code=code, defaults={"host": request.user}
            )
            if created:
                Player.objects.create(room=room, user=request.user, seat=0)
                return redirect('room', code=code)
        return HttpResponseServerError("Unable to generate unique room code. Please try again.")
    return render(request, 'game/create_room.html')

@login_required
def join_room(request):
    if request.method == "POST":
        code = request.POST.get("code", "").upper().strip()
        room = get_object_or_404(Room, code=code)
        # join if not already present
        if not room.players.filter(user=request.user).exists():
            next_seat = room.players.count()
            Player.objects.create(room=room, user=request.user, seat=next_seat)
            channel_layer = get_channel_layer()
            if channel_layer is not None:
                async_to_sync(channel_layer.group_send)(
                    f"room_{room.code}",
                    {"type": "player_joined", "user_id": request.user.id},
                )
        return redirect('room', code=code)
    return render(request, 'game/join_room.html')

@login_required
def room(request, code):
    room = get_object_or_404(Room, code=code)
    players = room.players.select_related("user").all()
    is_host = request.user == room.host
    try:
        initial_state = room.gamestate.state_json or {}
    except GameState.DoesNotExist:
        initial_state = {}
    current_turn_id = initial_state.get("turn") if isinstance(initial_state, dict) else None
    return render(
        request,
        'game/room.html',
        {
            "room": room,
            "players": players,
            "is_host": is_host,
            "current_turn_id": current_turn_id,
        },
    )
