import random
import string
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from .models import Room, Player

def _gen_code(n=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=n))

@login_required
def create_room(request):
    if request.method == "POST":
        code = _gen_code()
        room = Room.objects.create(code=code, host=request.user)
        Player.objects.create(room=room, user=request.user, seat=0)
        return redirect('room', code=code)
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
        return redirect('room', code=code)
    return render(request, 'game/join_room.html')

@login_required
def room(request, code):
    room = get_object_or_404(Room, code=code)
    players = room.players.select_related("user").all()
    return render(request, 'game/room.html', {"room": room, "players": players})
