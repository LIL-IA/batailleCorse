from django.db import models
from django.contrib.auth.models import User

class Room(models.Model):
    code = models.CharField(max_length=8, unique=True)
    host = models.ForeignKey(User, on_delete=models.CASCADE, related_name="hosted_rooms")
    is_started = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.code

class Player(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="players")
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    seat = models.PositiveSmallIntegerField()
    is_active = models.BooleanField(default=True)

    class Meta:
        unique_together = ("room", "user")
        ordering = ["seat"]

class GameState(models.Model):
    room = models.OneToOneField(Room, on_delete=models.CASCADE)
    state_json = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)
