from django.db import migrations


def create_missing_profiles(apps, schema_editor):
    """Crée un profil pour les utilisateurs qui n'en ont pas encore
    (comptes créés avant l'ajout du modèle UserProfile)."""
    User = apps.get_model("auth", "User")
    UserProfile = apps.get_model("game", "UserProfile")
    existing = set(UserProfile.objects.values_list("user_id", flat=True))
    UserProfile.objects.bulk_create(
        [UserProfile(user_id=uid) for uid in User.objects.values_list("id", flat=True)
         if uid not in existing]
    )


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("game", "0004_userprofile"),
    ]

    operations = [
        migrations.RunPython(create_missing_profiles, noop),
    ]
