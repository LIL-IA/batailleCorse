from django.contrib.auth.forms import UserCreationForm
from django.shortcuts import render, redirect
from django.contrib.auth import login

def signup(request):
    if request.method == 'POST':
        form = UserCreationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect('home')
    else:
        form = UserCreationForm()
    return render(request, 'registration/signup.html', {'form': form})

def room(request, code):
    room = get_object_or_404(Room, code=code)
    # Auto-join si pas encore joueur et partie non démarrée
    if not room.players.filter(user=request.user).exists() and not room.is_started:
        next_seat = room.players.count()
        Player.objects.create(room=room, user=request.user, seat=next_seat)
    players = room.players.select_related("user").all()
    return render(request, 'game/room.html', {"room": room, "players": players})
