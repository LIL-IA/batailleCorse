from django.db import models
from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

class Room(models.Model):
    code = models.CharField(max_length=8, unique=True)
    host = models.ForeignKey(User, on_delete=models.CASCADE, related_name="hosted_rooms")
    is_started = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    rules_options = models.JSONField(default=dict, blank=True)

    def __str__(self):
        return self.code

class Player(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="players")
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    seat = models.PositiveSmallIntegerField()
    is_active = models.BooleanField(default=True)
    is_ready = models.BooleanField(default=False)

    class Meta:
        unique_together = ("room", "user")
        ordering = ["seat"]

class GameState(models.Model):
    room = models.OneToOneField(Room, on_delete=models.CASCADE)
    state_json = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    easter_egg_unlocked = models.BooleanField(default=False)
    easter_egg_active = models.BooleanField(default=False)

# Garantit qu'un profil existe pour chaque utilisateur. get_or_create est
# idempotent : il crée le profil pour les nouveaux comptes ET répare ceux créés
# avant l'ajout du modèle UserProfile (sinon leur connexion planterait sur
# instance.profile, qui n'existe pas encore).
@receiver(post_save, sender=User)
def ensure_user_profile(sender, instance, created, **kwargs):
    UserProfile.objects.get_or_create(user=instance)